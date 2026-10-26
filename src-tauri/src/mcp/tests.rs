use super::*;
use tauri::Listener;
fn init(session: &mut protocol::Session) {
    let response=session.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","clientInfo":{"name":"test","version":"1"},"capabilities":{}}}),|_,_|unreachable!()).unwrap();
    assert_eq!(response["result"]["protocolVersion"], "2025-11-25");
    assert!(session
        .handle(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            |_, _| unreachable!()
        )
        .is_none());
}
#[test]
fn protocol_requires_negotiation_and_exposes_only_catalogued_tools() {
    let mut session = protocol::Session::default();
    assert_eq!(
        session
            .handle(
                json!({"jsonrpc":"2.0","id":0,"method":"tools/list"}),
                |_, _| unreachable!()
            )
            .unwrap()["error"]["code"],
        -32002
    );
    init(&mut session);
    let result = session
        .handle(
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            |_, _| unreachable!(),
        )
        .unwrap();
    let tools = result["result"]["tools"].as_array().unwrap();
    assert!(tools.len() > 85);
    assert!(!tools.iter().any(|t| t["name"] == "studio_replace_project"
        || t["name"].as_str().unwrap().starts_with("studio_mcp_")));
    assert!(tools.iter().any(|t| t["name"] == "studio_export_mkv"));
    let result=session.handle(json!({"jsonrpc":"2.0","id":"bad","method":"tools/call","params":{"name":"eval","arguments":{}}}),|_,_|unreachable!()).unwrap();
    assert_eq!(result["error"]["code"], -32602);
}
#[test]
fn nested_schema_references_context_and_error_results_are_validated() {
    let mut session = protocol::Session::default();
    init(&mut session);
    let request = |arguments| json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"studio_edit_voice","arguments":arguments}});
    let arguments = json!({"context":{"projectId":"p","expectedRevision":0},"id":"take","startMs":0,"endMs":500,"operation":{"kind":"gain","gain":1.5}});
    assert!(protocol::validate(
        &protocol::tool("studio_edit_voice").unwrap()["inputSchema"],
        &arguments
    ));
    let result = session
        .handle(request(arguments.clone()), |_, _| {
            Err("VOICE_EDIT_FAILED".into())
        })
        .unwrap();
    assert_eq!(result["result"]["isError"], true);
    let mut bad = arguments.clone();
    bad["operation"] = json!({"kind":"gain"});
    assert_eq!(
        session.handle(request(bad), |_, _| unreachable!()).unwrap()["error"]["code"],
        -32602
    );
    let mut bad = arguments;
    bad["context"]["expectedRevision"] = json!(0.1);
    assert!(!protocol::validate(
        &protocol::tool("studio_edit_voice").unwrap()["inputSchema"],
        &bad
    ));
    for (name, arguments, field) in [
        (
            "studio_set_character_profile",
            json!({"context":{"projectId":"p","expectedRevision":0},"id":"character","changes":{"gender":"man","vocalRegister":{"medianHz":180,"confidence":0.9,"analyzedMs":1500}}}),
            "changes",
        ),
        (
            "studio_merge_characters",
            json!({"context":{"projectId":"p","expectedRevision":0},"options":{"ids":["a","b"],"keepId":"a","preparedReference":{"id":"ref","label":"Reference","path":"characters/ref.wav","durationMs":2000,"transcript":"Bonjour"}}}),
            "options",
        ),
    ] {
        let schema = &protocol::tool(name).unwrap()["inputSchema"];
        assert!(schema["$defs"].is_object());
        assert!(protocol::validate(schema, &arguments), "{name}");
        let mut invalid = arguments;
        invalid[field] = json!("invalid");
        assert!(!protocol::validate(schema, &invalid), "{name}");
    }
}
#[test]
fn resources_and_invalid_jsonrpc_do_not_execute_tools() {
    let mut session = protocol::Session::default();
    init(&mut session);
    let result=session.handle(json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"studio://schemas/Project"}}),|_,_|unreachable!()).unwrap();
    let schema: Value =
        serde_json::from_str(result["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert!(schema["$defs"].is_object());
    assert_eq!(
        session
            .handle(
                json!({"jsonrpc":"1.0","id":3,"method":"ping"}),
                |_, _| unreachable!()
            )
            .unwrap()["error"]["code"],
        -32600
    );
    assert!(session
        .handle(
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}),
            |_, _| unreachable!()
        )
        .is_none());
}
#[test]
fn local_listener_authenticates_and_never_exposes_its_token_in_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_app();
    let controller = Controller::new(app.handle().clone(), directory.path().to_path_buf());
    controller.start().unwrap();
    controller.set_ready(true);
    let endpoint: Endpoint =
        serde_json::from_slice(&std::fs::read(directory.path().join("mcp-endpoint.json")).unwrap())
            .unwrap();
    assert!(!controller.status().to_string().contains(&endpoint.token));
    let mut invalid = endpoint.clone();
    invalid.token = "0".repeat(64);
    assert_eq!(
        client::exchange(&invalid, json!({"op":"ping"})).unwrap_err(),
        "MCP_AUTH_FAILED"
    );
    assert_eq!(
        client::exchange(&endpoint, json!({"op":"ping"})).unwrap()["running"],
        true
    );
    let other = Controller::new(app.handle().clone(), directory.path().to_path_buf());
    assert_eq!(other.start().unwrap_err(), "MCP_OTHER_INSTANCE");
    drop(other);
    assert!(directory.path().join("mcp-endpoint.json").is_file());
    controller.stop();
    assert!(!directory.path().join("mcp-endpoint.json").exists());
}
#[test]
fn accepted_nonblocking_socket_waits_for_the_complete_request() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_app();
    let controller = Controller::new(app.handle().clone(), directory.path().to_path_buf());
    controller.start().unwrap();
    let endpoint: Endpoint =
        serde_json::from_slice(&std::fs::read(directory.path().join("mcp-endpoint.json")).unwrap())
            .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let (accepted, _) = listener.accept().unwrap();
    // Windows can inherit this mode from the accepting listener. Force it on
    // every platform so this regression also exercises the failure on Linux.
    accepted.set_nonblocking(true).unwrap();
    let worker = controller.clone();
    let (started, ready) = mpsc::channel();
    let task = std::thread::spawn(move || {
        started.send(()).unwrap();
        worker.serve(accepted);
    });
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let request = serde_json::to_vec(&json!({"op":"ping", "token":endpoint.token})).unwrap();
    let middle = request.len() / 2;
    client.write_all(&request[..middle]).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    client.write_all(&request[middle..]).unwrap();
    client.write_all(b"\n").unwrap();
    let mut response = String::new();
    BufReader::new(client).read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["value"]["running"], true);
    task.join().unwrap();
    controller.stop();
}
#[test]
fn actual_local_request_is_claimed_once_and_returns_the_ui_result() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_app();
    let controller = Controller::new(app.handle().clone(), directory.path().to_path_buf());
    controller.start().unwrap();
    controller.set_ready(true);
    let weak = Arc::downgrade(&controller);
    let event = app.listen("mcp-request", move |event| {
        let controller = weak.upgrade().unwrap();
        let id: String = serde_json::from_str(event.payload()).unwrap();
        let request = controller.claim(&id).unwrap().unwrap();
        assert_eq!(request.tool, "studio_get_state");
        assert!(controller.claim(&id).unwrap().is_none());
        assert!(controller.live(&id));
        controller.complete(
            &id,
            Some(json!({"context":{"projectId":"p","expectedRevision":4}})),
            None,
        );
    });
    let endpoint: Endpoint =
        serde_json::from_slice(&std::fs::read(directory.path().join("mcp-endpoint.json")).unwrap())
            .unwrap();
    let result = client::exchange(
        &endpoint,
        json!({"owner":"test","requestId":1,"tool":"studio_get_state","arguments":{}}),
    )
    .unwrap();
    assert_eq!(result["context"]["expectedRevision"], 4);
    app.unlisten(event);
    controller.stop();
}
#[test]
fn cancellation_before_arrival_and_disable_prevent_queued_or_late_execution() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_app();
    let controller = Controller::new(app.handle().clone(), directory.path().to_path_buf());
    controller.start().unwrap();
    controller.set_ready(true);
    controller.cancel("early", Some(&json!(1)));
    assert_eq!(
        controller
            .execute("early", json!(1), "studio_get_state", json!({}))
            .unwrap_err(),
        "MCP_CANCELLED"
    );
    let running = controller.clone();
    let task = std::thread::spawn(move || {
        running.execute("waiting", json!(2), "studio_get_state", json!({}))
    });
    let until = Instant::now() + Duration::from_secs(2);
    let id = loop {
        if let Some(id) = controller.pending.lock().unwrap().keys().next().cloned() {
            break id;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    };
    controller.stop();
    assert!(controller.claim(&id).unwrap().is_none());
    assert_eq!(task.join().unwrap().unwrap_err(), "MCP_DISABLED");
    let old = controller.token.lock().unwrap().clone();
    controller.start().unwrap();
    assert_ne!(*controller.token.lock().unwrap(), old);
    assert!(!controller.live(&id));
    controller.stop();
}
