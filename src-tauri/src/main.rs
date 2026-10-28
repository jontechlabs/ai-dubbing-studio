#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|v| v == "--mcp") {
        let result = if args.len() == 4 && args[2] == "--endpoint" {
            dubbing_studio_lib::mcp_stdio(std::path::Path::new(&args[3]))
        } else {
            Err("Use --mcp --endpoint PATH from Settings > MCP".into())
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if args
        .get(1)
        .is_some_and(|v| v == "--transcribe-reference" || v == "--transcribe-dialogue")
    {
        let result = if args.len() == 6 {
            let worker = if args[1] == "--transcribe-dialogue" {
                dubbing_studio_lib::transcribe_dialogue_worker
            } else {
                dubbing_studio_lib::transcribe_reference_worker
            };
            worker(
                std::path::Path::new(&args[2]),
                std::path::Path::new(&args[3]),
                &args[4].to_string_lossy(),
                std::path::Path::new(&args[5]),
            )
        } else {
            Err("INVALID_PATH".to_owned())
        };
        if let Err(error) = result {
            println!("{}", serde_json::json!({"error":error}));
            std::process::exit(1);
        }
        return;
    }
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
