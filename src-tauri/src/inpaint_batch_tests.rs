use super::*;
use crate::mix::tests::{core, fixture, tool};
use std::time::Duration;

fn selection() -> Selection {
    serde_json::from_value(serde_json::json!({
        "scope":"all","lineIds":[],"force":false,"useSavedCrops":true,
        "useCommonCrop":true,"activate":false,"crops":{},
        "options":{"modelId":"latentsync-16","inferenceSteps":20,"guidanceScale":1.5,
        "lineId":"line","generationId":"voice","device":"cuda:0",
        "face":{"x":0.1,"y":0.1,"width":0.6,"height":0.8},"endX":0.1,"endY":0.1,
        "mask":{"x":0.2,"y":0.6,"width":0.6,"height":0.3},
        "feather":0.12,"blend":1,"style":"live","seed":7}
    }))
    .unwrap()
}
async fn setup() -> (tempfile::TempDir, PathBuf, Project) {
    let (temp, root, mut p) = fixture().await;
    p.dialogues[0].end_ms = 1600;
    for cue in p.source_cues.iter_mut().chain(p.target_cues.iter_mut()) {
        cue.end_ms = 1600;
    }
    let mut line = p.dialogues[0].clone();
    line.id = "line2".into();
    line.start_ms = 2500;
    line.end_ms = 3100;
    line.source_cue_ids = vec!["s2".into()];
    line.target_cue_ids = vec!["t2".into()];
    line.selected_generation_ids
        .insert("fr".into(), "voice2".into());
    p.dialogues.push(line);
    let mut source = p.source_cues[0].clone();
    source.id = "s2".into();
    source.start_ms = 2500;
    source.end_ms = 3100;
    p.source_cues.push(source);
    let mut target = p.target_cues[0].clone();
    target.id = "t2".into();
    target.start_ms = 2500;
    target.end_ms = 3100;
    p.target_cues.push(target);
    let mut g = p.generations[0].clone();
    g["id"] = serde_json::json!("voice2");
    g["dialogueId"] = serde_json::json!("line2");
    g["startMs"] = serde_json::json!(2500);
    g["endMs"] = serde_json::json!(3100);
    g["path"] = serde_json::json!("generations/voice2.wav");
    p.generations.push(g);
    std::fs::copy(
        root.join("generations/voice.wav"),
        root.join("generations/voice2.wav"),
    )
    .unwrap();
    p.validate().unwrap();
    (temp, root, p)
}
fn worker(root: &Path) -> inpaint::WorkerLaunch {
    let model = root.join("protocol");
    std::fs::create_dir_all(&model).unwrap();
    let script = model.join("worker.py");
    std::fs::write(&script,r#"
import sys,json,struct,zlib,wave,os,time
from pathlib import Path
if '--info' in sys.argv:
    print(json.dumps({'devices':[{'id':'cuda:0','name':'protocol stub'}]}));sys.exit()
r=json.loads(Path(sys.argv[sys.argv.index('--request')+1]).read_text(encoding='utf-8-sig'))
home=Path(r['modelDirectory'])
calls=home/'calls.txt'
with calls.open('a') as f:f.write(str(os.getpid())+'\n')
n=len(calls.read_text().splitlines())
assert 'media' not in Path(r['audioPath']).parts
with wave.open(r['audioPath']) as a:
    assert a.getnchannels()==1 and a.getframerate()==16000
    assert abs(a.getnframes()-r['frames']*640)<=1
if n==2 and (home/'slow-second').exists():
    (home/'waiting').write_text(str(os.getpid()))
    time.sleep(60)
if n==2 and (home/'fail-second').exists():raise ValueError('INPAINT_FRAME_INVALID')
size=512 if r['modelId']=='latentsync-16' else 256
def chunk(k,b):return struct.pack('>I',len(b))+k+b+struct.pack('>I',zlib.crc32(k+b)&0xffffffff)
data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0\xff'*size)*size))+chunk(b'IEND',b'')
for i in range(r['frames']):Path(r['outputDirectory'],f'{i:06}.png').write_bytes(data)
print(json.dumps({'stage':'inpaintGenerate','progress':1}),flush=True)
"#).unwrap();
    inpaint::WorkerLaunch {
        python: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
        script,
        model,
    }
}
async fn finished(core: &Core, key: &str) -> jobs::Job {
    for _ in 0..6000 {
        let j = core
            .jobs
            .lock()
            .unwrap()
            .get(key)
            .unwrap()
            .saved
            .record
            .clone();
        if !["running", "queued"].contains(&j.status.as_str()) {
            return j;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("lip batch timed out");
}
fn request(p: &Project, root: &Path, s: &Selection) -> Request {
    let (preview, items) = plan(p, root, s).unwrap();
    Request {
        activate: s.activate,
        root: root.into(),
        project_id: p.id.clone(),
        language: p.languages.target.clone(),
        items,
        skipped: preview.requested - preview.ready.len(),
    }
}
#[tokio::test]
async fn plan_requires_explicit_crops_and_limits_scope_to_selected_dubbed_lines() {
    let (_temp, root, mut p) = setup().await;
    let mut s = selection();
    s.use_common_crop = false;
    let (preview, items) = plan(&p, &root, &s).unwrap();
    assert_eq!(preview.missing_crop, 2);
    assert!(items.is_empty());
    s.scope = "selected".into();
    s.line_ids = vec!["line2".into()];
    s.use_common_crop = true;
    let (preview, items) = plan(&p, &root, &s).unwrap();
    assert_eq!(preview.ready, vec!["line2"]);
    assert_eq!(items[0].request.options.model(), "latentsync-16");
    assert_eq!(items[0].request.options.generation_id, "voice2");
    p.dialogues[1].selected_generation_ids.clear();
    assert_eq!(plan(&p, &root, &s).unwrap().0.undubbed, 1);
    s.line_ids = vec!["missing".into()];
    assert!(plan(&p, &root, &s).is_err());
}
#[tokio::test]
async fn batch_keeps_independent_clips_source_and_takes_and_resumes_only_failed_items() {
    let (_temp, root, p) = setup().await;
    let source = std::fs::read(root.join("media/source.mkv")).unwrap();
    let take = std::fs::read(root.join("generations/voice.wav")).unwrap();
    let launch = worker(&root);
    std::fs::write(launch.model.join("fail-second"), b"").unwrap();
    let request = request(&p, &root, &selection());
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        request,
        Some(launch.clone()),
    )
    .unwrap();
    let done = finished(&core, &key).await;
    assert_eq!(done.status, "failed", "{:?}", done.logs);
    assert_eq!(done.batch.unwrap().succeeded, 1);
    let saved = load(&core, &key).unwrap();
    assert_eq!(saved.items[0].status, "succeeded");
    assert_eq!(saved.items[1].status, "failed");
    let key2 = resume_with_launch(
        core.clone(),
        app.handle().clone(),
        saved,
        Some(launch.clone()),
    )
    .unwrap();
    let done = finished(&core, &key2).await;
    assert_eq!(done.status, "succeeded", "{:?}", done.logs);
    assert_eq!(done.batch.unwrap().succeeded, 2);
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    let edits = inpaint::edits(&p).unwrap();
    assert_eq!(edits.len(), 2);
    assert!(edits.iter().all(|e| !e.enabled && e.duration_ms == 600));
    assert_eq!(edits[0].start_ms, 1000);
    assert_eq!(edits[1].start_ms, 2500);
    assert_ne!(edits[0].path, edits[1].path);
    for e in &edits {
        let info = crate::media::probe_executable(&tool("ffprobe"), &root.join(&e.path))
            .await
            .unwrap();
        assert_eq!(info.duration_ms, 600);
        assert!(info.streams.iter().all(|s| s.kind != "audio"));
    }
    assert_eq!(
        std::fs::read(root.join("media/source.mkv")).unwrap(),
        source
    );
    assert_eq!(
        std::fs::read(root.join("generations/voice.wav")).unwrap(),
        take
    );
    let mut s = selection();
    assert_eq!(plan(&p, &root, &s).unwrap().0.existing, 2);
    s.force = true;
    s.use_common_crop = false;
    assert_eq!(plan(&p, &root, &s).unwrap().0.ready.len(), 2); // saved per-dialogue framing
    let again = resume_with_launch(
        core.clone(),
        app.handle().clone(),
        load(&core, &key2).unwrap(),
        Some(launch.clone()),
    )
    .unwrap();
    assert_eq!(finished(&core, &again).await.status, "succeeded");
    assert_eq!(
        std::fs::read_to_string(launch.model.join("calls.txt"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}
#[tokio::test]
async fn cancellation_retains_completed_clip_kills_worker_and_replays_only_pending_dialogue() {
    let (_temp, root, p) = setup().await;
    let launch = worker(&root);
    std::fs::write(launch.model.join("slow-second"), b"").unwrap();
    let mut s = selection();
    s.activate = true;
    let req = request(&p, &root, &s);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        Some(launch.clone()),
    )
    .unwrap();
    for _ in 0..6000 {
        if launch.model.join("waiting").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(launch.model.join("waiting").exists());
    core.jobs
        .lock()
        .unwrap()
        .get(&key)
        .unwrap()
        .cancel
        .store(true, Ordering::Relaxed);
    assert_eq!(finished(&core, &key).await.status, "cancelled");
    let pid = std::fs::read_to_string(launch.model.join("waiting")).unwrap();
    let exited=crate::media::command(&launch.python).args(["-c",r#"import os,sys,ctypes
pid=int(sys.argv[1])
if os.name=='nt':
    handle=ctypes.windll.kernel32.OpenProcess(0x1000,False,pid)
    if handle:
        code=ctypes.c_ulong();ctypes.windll.kernel32.GetExitCodeProcess(handle,ctypes.byref(code));ctypes.windll.kernel32.CloseHandle(handle)
        sys.exit(1 if code.value==259 else 0)
else:
    try:os.kill(pid,0)
    except ProcessLookupError:sys.exit(0)
    sys.exit(1)
"#,&pid]).status().await.unwrap();
    assert!(exited.success(), "cancelled lip worker is still alive");
    let mut req = load(&core, &key).unwrap();
    assert_eq!(req.items[0].status, "succeeded");
    assert_eq!(req.items[1].status, "pending");
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    assert_eq!(inpaint::edits(&p).unwrap().len(), 1);
    assert!(inpaint::edits(&p).unwrap()[0].enabled);
    // A committed sequence is also recovered if its final outcome record was interrupted.
    req.items[0].status = "pending".into();
    let again = resume_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        Some(launch.clone()),
    )
    .unwrap();
    assert_eq!(finished(&core, &again).await.status, "succeeded");
    assert_eq!(
        inpaint::edits(&core.session.lock().unwrap().as_ref().unwrap().project)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        std::fs::read_to_string(launch.model.join("calls.txt"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}
