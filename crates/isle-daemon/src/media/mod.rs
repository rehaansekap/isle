// SPDX-License-Identifier: GPL-3.0-or-later

//! Now-playing information and playback control for whichever MPRIS player
//! (Spotify, browsers, mpv, ...) is currently active, plus its lyrics.

mod art;
mod gap;
mod lyrics;
mod mpris;

use log::warn;
use serde::Serialize;
use tokio::sync::mpsc;
use zbus::zvariant::OwnedObjectPath;
use zbus::{fdo, interface};

pub use self::lyrics::{Lyrics, LyricsProvider};
pub use self::mpris::watch;
use self::mpris::{PlayerProxy, bounded};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NowPlaying {
    /// False when no player is running; every other field is then empty.
    pub available: bool,
    /// The player's name for display, e.g. "Spotify".
    pub identity: String,
    /// Desktop file id without ".desktop", for the player's icon.
    pub desktop_entry: String,
    /// "Playing", "Paused" or "Stopped".
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Local path of the cover art, or empty while unknown.
    pub art_path: String,
    pub length_us: i64,
    /// Playback position when it was sampled. While playing, the current
    /// position is `position_us + (now - sampled_at_ms) * 1000 * rate`.
    pub position_us: i64,
    pub sampled_at_ms: i64,
    pub rate: f64,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_play_pause: bool,
    pub can_seek: bool,
}

/// Within this, a position sampled again is the same moment of the song.
const SAME_POSITION_MS: f64 = 250.0;

impl NowPlaying {
    /// Whether `next` says nothing new: the same song and state, at the position this one predicts.
    /// Players send their properties again often (volume, shuffle, a browser's metadata), each time
    /// with a fresh sample of the position.
    pub fn continues_as(&self, next: &NowPlaying) -> bool {
        let without_time = |n: &NowPlaying| NowPlaying {
            position_us: 0,
            sampled_at_ms: 0,
            ..n.clone()
        };
        if without_time(self) != without_time(next) {
            return false;
        }
        let elapsed_ms = (next.sampled_at_ms - self.sampled_at_ms) as f64;
        let advance = if self.status == "Playing" {
            elapsed_ms * self.rate
        } else {
            0.0
        };
        let predicted_us = self.position_us as f64 + advance * 1000.0;
        (predicted_us - next.position_us as f64).abs() < SAME_POSITION_MS * 1000.0
    }
}

/// A player that runs, offered to pick from when there are several.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PlayerChoice {
    /// Its name on the bus, for `Choose`.
    pub name: String,
    pub identity: String,
    pub desktop_entry: String,
    pub playing: bool,
    /// The one shown and controlled now.
    pub active: bool,
}

/// What the user asked of the watcher (see mpris.rs).
pub enum Wish {
    /// Show and control this player, until another starts playing.
    Player(String),
    /// Look lyrics up online, or not.
    Lyrics(bool),
    /// Which provider looks up lyrics online.
    LyricsProvider(LyricsProvider),
}

#[derive(Default)]
pub struct MediaService {
    now_playing: NowPlaying,
    lyrics: Lyrics,
    players: Vec<PlayerChoice>,
    /// The active player and the id of its current track.
    active: Option<(PlayerProxy<'static>, Option<OwnedObjectPath>)>,
    /// To the watcher, once it runs.
    wishes: Option<mpsc::UnboundedSender<Wish>>,
}

impl MediaService {
    /// Sends a command to the active player in a task of its own, bounded by a timeout.
    /// zbus holds this interface while a method runs, so awaiting a hung player freezes media.
    fn send<F, Fut>(&self, command: &'static str, call: F) -> fdo::Result<()>
    where
        F: FnOnce(PlayerProxy<'static>, Option<OwnedObjectPath>) -> Fut + Send + 'static,
        Fut: Future<Output = zbus::Result<()>> + Send + 'static,
    {
        let (player, track) = self
            .active
            .clone()
            .ok_or_else(|| fdo::Error::Failed("no media player is running".into()))?;
        let name = player.inner().destination().to_string();
        tokio::spawn(async move {
            if let Err(err) = bounded(call(player, track)).await {
                warn!("{name} did not handle {command}: {err}");
            }
        });
        Ok(())
    }
}

#[interface(name = "io.github.zickrian.isle.Media1")]
impl MediaService {
    fn play_pause(&self) -> fdo::Result<()> {
        self.send(
            "PlayPause",
            |player, _| async move { player.play_pause().await },
        )
    }

    fn next(&self) -> fdo::Result<()> {
        self.send("Next", |player, _| async move { player.next().await })
    }

    fn previous(&self) -> fdo::Result<()> {
        self.send(
            "Previous",
            |player, _| async move { player.previous().await },
        )
    }

    /// Seeks to an absolute position in microseconds.
    fn set_position(&self, position_us: i64) -> fdo::Result<()> {
        let position_us = position_us.max(0);
        self.send("SetPosition", move |player, track| async move {
            match track {
                Some(track) => player.set_position(&track, position_us).await,
                // Without a track id only a relative seek works; measure it from the player's
                // live position, since our own sample may be seconds old.
                None => {
                    let current = player.position().await?;
                    player.seek(position_us.saturating_sub(current)).await
                }
            }
        })
    }

    /// Shows and controls the player named `name` (from `Players`), until another starts playing.
    fn choose(&self, name: &str) -> fdo::Result<()> {
        self.wish(Wish::Player(name.to_owned()))
    }

    /// Whether lyrics are looked up online; off, the lyrics say so instead.
    fn set_lyrics(&self, enabled: bool) -> fdo::Result<()> {
        self.wish(Wish::Lyrics(enabled))
    }

    /// Sets which provider to use: 'auto' (Lyrics Plus), 'netease', or 'lrclib'.
    fn set_lyrics_provider(&self, provider: &str) -> fdo::Result<()> {
        let p = match provider {
            "netease" => LyricsProvider::Netease,
            "lrclib" => LyricsProvider::Lrclib,
            _ => LyricsProvider::Auto,
        };
        self.wish(Wish::LyricsProvider(p))
    }

    /// Brings the player's window to the front.
    fn raise(&self) -> fdo::Result<()> {
        self.send("Raise", |player, _| async move {
            let app = mpris::AppProxy::builder(player.inner().connection())
                .destination(player.inner().destination().to_owned())?
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await?;
            app.raise().await
        })
    }

    /// JSON `NowPlaying`.
    #[zbus(property)]
    fn now_playing(&self) -> String {
        serde_json::to_string(&self.now_playing).unwrap_or_default()
    }

    /// JSON `Lyrics` for the current track.
    #[zbus(property)]
    fn lyrics(&self) -> String {
        serde_json::to_string(&self.lyrics).unwrap_or_default()
    }

    /// JSON `[PlayerChoice]`: the players that run, by name.
    #[zbus(property)]
    fn players(&self) -> String {
        serde_json::to_string(&self.players).unwrap_or_default()
    }
}

impl MediaService {
    fn wish(&self, wish: Wish) -> fdo::Result<()> {
        self.wishes
            .as_ref()
            .and_then(|wishes| wishes.send(wish).ok())
            .ok_or_else(|| fdo::Error::Failed("media is not watched yet".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_sample_of_the_same_moment_is_nothing_new() {
        let playing = NowPlaying {
            available: true,
            status: "Playing".into(),
            title: "Midnight Drive".into(),
            position_us: 60_000_000,
            sampled_at_ms: 1_000,
            rate: 1.0,
            ..NowPlaying::default()
        };
        // Two seconds on, two seconds further: the same.
        let later = NowPlaying {
            position_us: 62_010_000,
            sampled_at_ms: 3_000,
            ..playing.clone()
        };
        assert!(playing.continues_as(&later));
        // A seek, a pause or another song is news.
        assert!(!playing.continues_as(&NowPlaying {
            position_us: 90_000_000,
            ..later.clone()
        }));
        assert!(!playing.continues_as(&NowPlaying {
            status: "Paused".into(),
            ..later.clone()
        }));
        assert!(!playing.continues_as(&NowPlaying {
            title: "Other".into(),
            ..later
        }));
        // Paused, the position stays put.
        let paused = NowPlaying {
            status: "Paused".into(),
            ..playing
        };
        assert!(paused.continues_as(&NowPlaying {
            sampled_at_ms: 9_000,
            ..paused.clone()
        }));
    }
}
