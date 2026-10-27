pub mod domain;
pub mod map_background;
pub mod obs_config;
pub mod postmatch;
pub mod replay;
pub mod runtime;
pub mod smart_overlay;
pub mod smart_phase;
pub mod storage;
pub mod widget_server;

#[cfg(feature = "desktop")]
mod shell;

#[cfg(feature = "desktop")]
pub use shell::run;
