#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|v| v == "--smoke-test") {
        let result = args
            .get(2)
            .ok_or_else(|| "INVALID_PATH".to_owned())
            .and_then(|p| dubbing_studio_lib::smoke_test(std::path::Path::new(p)));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    dubbing_studio_lib::run();
}
