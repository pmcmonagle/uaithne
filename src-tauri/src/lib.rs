mod commands;
mod error;
mod midi;
mod osc;
mod packs;
mod record;
mod samples;
mod settings;
mod tidal;
mod workspace;

use commands::AppState;
use tauri::{Manager, RunEvent};
use tidal::Tidal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Window size, position and maximised state, restored on the next launch.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState::default())
        .manage(Tidal::default())
        .manage(record::Recorder::default())
        .manage(midi::Midi::default())
        .manage(osc::Osc::default())
        // Sample files for the webview: uaithne://localhost/<percent-encoded path>.
        .register_asynchronous_uri_scheme_protocol("uaithne", |ctx, request, responder| {
            let root = ctx.app_handle().state::<AppState>().root();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || responder.respond(samples::serve(root, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            commands::frontend_log,
            commands::selftest_enabled,
            commands::selftest_pack,
            commands::get_settings,
            commands::set_volume,
            commands::update_settings,
            commands::user_theme_css,
            commands::open_workspace,
            commands::list_tracks,
            commands::read_track,
            commands::write_track,
            commands::create_track,
            commands::rename_track,
            commands::delete_track,
            commands::sample_library,
            commands::pack_catalogue,
            commands::pack_id_for,
            commands::install_pack,
            commands::cancel_pack,
            commands::delete_pack,
            commands::selftest_tidal,
            commands::tidal_check,
            commands::tidal_status,
            commands::tidal_start,
            commands::tidal_stop,
            commands::tidal_eval,
            commands::tidal_volume,
            commands::tidal_relink,
            commands::tidal_reload_samples,
            commands::tidal_meter,
            commands::record_start,
            commands::record_chunk,
            commands::record_stop,
            commands::selftest_wav,
            commands::midi_outputs,
            commands::midi_send,
            commands::osc_send,
            commands::set_io_settings,
            commands::selftest_midi_capture,
            commands::selftest_tidal_midi,
            commands::selftest_crash,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Don't leave GHCi, sclang or scsynth running.
            if let RunEvent::Exit = event {
                if !commands::finish_recording(app).is_empty() {
                    // Give SuperCollider a moment to close its file before it's stopped.
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
                app.state::<Tidal>().stop(None);
            }
        });
}
