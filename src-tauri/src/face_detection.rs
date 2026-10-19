//! Conservative CPU face framing proposals. No project/video mutation.
use crate::{domain::io_error, inpaint, inpaint_batch, jobs, project, separation, Core};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub source_path: String,
    pub model_id: String,
    pub profile: String,
    pub items: Vec<inpaint::Request>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub line_id: String,
    pub generation_id: String,
    pub fingerprint: String,
    pub crop: Option<inpaint_batch::Crop>,
    pub reason: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub project_id: String,
    pub source_path: String,
    pub items: Vec<Proposal>,
}
#[derive(Deserialize)]
struct File {
    name: String,
    url: String,
    size: u64,
    sha256: String,
}
#[derive(Deserialize)]
struct Manifest {
    files: Vec<File>,
    wheel: File,
}
pub fn snapshot(
    core: &Core,
    selection: &inpaint_batch::Selection,
    profile: &str,
) -> Result<Request, String> {
    if !["auto", "anime", "live"].contains(&profile) {
        return Err("FACE_PROFILE_INVALID".into());
    }
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    let mut all = selection.clone();
    all.use_common_crop = true;
    let (_, items) = inpaint_batch::plan(&s.project, &s.root, &all)?;
    let saved = inpaint::edits(&s.project)?;
    let items: Vec<_> = items
        .into_iter()
        .filter(|i| {
            !selection.crops.contains_key(&i.request.options.line_id)
                && !(selection.use_saved_crops
                    && saved.iter().any(|e| {
                        e.dialogue_id == i.request.options.line_id
                            && s.project
                                .media
                                .as_ref()
                                .is_some_and(|m| m.path == e.source_path)
                    }))
        })
        .map(|i| i.request)
        .collect();
    if items.is_empty() {
        return Err("FACE_BATCH_EMPTY".into());
    }
    Ok(Request {
        root: s.root.clone(),
        project_id: s.project.id.clone(),
        source_path: s
            .project
            .media
            .as_ref()
            .ok_or("MEDIA_MISSING")?
            .path
            .clone(),
        model_id: selection.options.model().into(),
        profile: profile.into(),
        items,
    })
}
fn path(core: &Core, key: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(key).map_err(|_| "FACE_RESULT_INVALID")?;
    Ok(core
        .data_dir
        .join("face-detections")
        .join(format!("{key}.json")))
}
pub fn result(core: &Core, key: &str) -> Result<Option<ResultSet>, String> {
    let file = path(core, key)?;
    if !file.exists() {
        return Ok(None);
    }
    let mut result: ResultSet =
        serde_json::from_slice(&std::fs::read(file).map_err(io_error)?).map_err(io_error)?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.project.id != result.project_id
        || s.project
            .media
            .as_ref()
            .is_none_or(|m| m.path != result.source_path)
    {
        return Err("INPAINT_STALE".into());
    }
    // Build the clip schedule once: thousands of proposals must not rebuild it
    // for every row while holding the project lock.
    let clips = crate::mix::clips(&s.project);
    let by_id: std::collections::HashMap<_, _> = clips.iter().map(|c| (c.id.as_str(), c)).collect();
    let selected: std::collections::HashMap<_, _> = s
        .project
        .dialogues
        .iter()
        .filter_map(|l| {
            Some((
                l.id.as_str(),
                l.selected_generation_ids
                    .get(&s.project.languages.target)?
                    .as_str(),
            ))
        })
        .collect();
    let owners: std::collections::HashMap<_, _> = s
        .project
        .generations
        .iter()
        .filter_map(|g| Some((g["id"].as_str()?, g["dialogueId"].as_str()?)))
        .collect();
    for row in &mut result.items {
        if selected.get(row.line_id.as_str()).copied() != Some(row.generation_id.as_str())
            || owners.get(row.generation_id.as_str()).copied() != Some(row.line_id.as_str())
            || !by_id.get(row.generation_id.as_str()).is_some_and(|clip| {
                inpaint::fingerprint(&s.project, &row.generation_id, clip)
                    .is_ok_and(|hash| hash == row.fingerprint)
            })
        {
            row.crop = None;
            row.reason = Some("INPAINT_STALE".into());
        }
    }
    Ok(Some(result))
}
async fn runtime<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &Arc<AtomicBool>,
) -> Result<(PathBuf, PathBuf), String> {
    let root = inpaint::runtime_root(core, &request.model_id);
    let python = separation::python(&root);
    if !python.is_file() {
        return Err("INPAINT_NOT_INSTALLED".into());
    }
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../workers/face-detection.json"))
            .map_err(io_error)?;
    let folder = root.join("face-detection");
    std::fs::create_dir_all(&folder).map_err(io_error)?;
    #[cfg(windows)]
    if crate::voice_space::available(&folder)? < 256 * 1024 * 1024 {
        return Err("INPAINT_DISK_REQUIRED".into());
    }
    let worker = separation::resources(app).join("face_detection_worker.py");
    let probe = || vec![worker.to_string_lossy().into_owned(), "--info".into()];
    let ready = separation::probe(&python, &probe(), flag, Duration::from_secs(30))
        .await?
        .is_some_and(|v| v["runtimeReady"] == true);
    if !ready {
        let f = manifest.wheel;
        let archive = folder.join(&f.name);
        separation::fetch(
            core,
            app,
            key,
            std::slice::from_ref(&f.url),
            &archive,
            (&f.sha256, f.size),
            flag,
        )
        .await?;
        let target = root.join("python/Lib/site-packages");
        let cancelled = flag.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::tts::extract(&archive, &target, &cancelled)
        })
        .await
        .map_err(io_error)??;
        if !separation::probe(&python, &probe(), flag, Duration::from_secs(30))
            .await?
            .is_some_and(|v| v["runtimeReady"] == true)
        {
            return Err("FACE_RUNTIME_FAILED".into());
        }
    }
    for f in manifest.files {
        separation::fetch(
            core,
            app,
            key,
            std::slice::from_ref(&f.url),
            &folder.join(&f.name),
            (&f.sha256, f.size),
            flag,
        )
        .await?;
    }
    Ok((python, folder))
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    selection: inpaint_batch::Selection,
    profile: String,
) -> Result<String, String> {
    let request = snapshot(&core, &selection, &profile)?;
    if !inpaint::installed(&core, &request.model_id) {
        return Err("INPAINT_NOT_INSTALLED".into());
    }
    start(core, app, request)
}
pub fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    start_with_launch(core, app, request, None)
}
pub(crate) fn start_with_launch<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
    launch: Option<inpaint::WorkerLaunch>,
) -> Result<String, String> {
    if !["auto", "anime", "live"].contains(&request.profile.as_str()) || request.items.is_empty() {
        return Err("FACE_PROFILE_INVALID".into());
    }
    {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project
                .media
                .as_ref()
                .is_none_or(|m| m.path != request.source_path)
        {
            return Err("INPAINT_STALE".into());
        }
    }
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    let key = jobs::create(
        &core,
        &app,
        "faceDetection",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .face_detection = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let outcome:Result<(),String>=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="faceInstall".into();j.logs.push("CPU face proposals only. Main video and prepared manual crops are unchanged.".into());});
            let launch=if let Some(launch)=launch{launch}else{
                let (python,model)=runtime(&core,&app,&key,&request,&flag).await?;
                inpaint::WorkerLaunch{python,model,script:separation::resources(&app).join("face_detection_worker.py")}
            };
            let ff=crate::media::binary(&app,"ffmpeg")?;
            let source=project::asset(&request.root,&request.source_path)?;
            project::ensure_directory(&request.root,"cache")?;
            let mut results=ResultSet{project_id:request.project_id.clone(),source_path:request.source_path.clone(),items:vec![]};
            for (index,item) in request.items.iter().enumerate(){
                if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
                let clip={let g=core.session.lock().map_err(io_error)?;let s=g.as_ref().ok_or("NO_PROJECT")?;
                    if s.root!=request.root||s.project.id!=request.project_id{return Err("INPAINT_STALE".into());}
                    let (hash,clip)=inpaint::signature(&s.project,&item.options.line_id,&item.options.generation_id)?;
                    if hash!=item.fingerprint{return Err("INPAINT_STALE".into());}clip};
                let temp=tempfile::tempdir_in(request.root.join("cache")).map_err(io_error)?;
                let seconds=clip.duration_ms() as f64/1000.;
                jobs::update(&core,&app,&key,|j|{j.stage="faceDetection".into();j.progress=Some(index as f64/request.items.len() as f64);j.logs.push(format!("Framing {}/{}: {}",index+1,request.items.len(),item.options.line_id));});
                let args=vec!["-nostdin".into(),"-v".into(),"error".into(),"-ss".into(),format!("{:.3}",clip.start_ms() as f64/1000.),"-i".into(),source.to_string_lossy().into_owned(),"-t".into(),format!("{seconds:.3}"),"-an".into(),"-vf".into(),format!("fps={:.9},scale='min(960,iw)':-2",5./seconds),"-frames:v".into(),"5".into(),"-start_number".into(),"0".into(),temp.path().join("%06d.png").to_string_lossy().into_owned()];
                separation::process(&core,&app,&key,&ff,&args,&flag).await?;
                let output=temp.path().join("result.json");let input=temp.path().join("request.json");
                project::atomic_write(&input,&serde_json::to_vec(&serde_json::json!({"profile":request.profile,"models":launch.model,"inputDirectory":temp.path(),"output":output})).map_err(io_error)?)?;
                tokio::time::timeout(Duration::from_secs(90),separation::process(&core,&app,&key,&launch.python,&[launch.script.to_string_lossy().into_owned(),"--request".into(),input.to_string_lossy().into_owned()],&flag)).await.map_err(|_|"FACE_RUNTIME_FAILED")??;
                let value:serde_json::Value=serde_json::from_slice(&std::fs::read(&output).map_err(io_error)?).map_err(io_error)?;
                let mut row=Proposal{line_id:item.options.line_id.clone(),generation_id:item.options.generation_id.clone(),fingerprint:item.fingerprint.clone(),crop:serde_json::from_value(value["crop"].clone()).map_err(io_error)?,reason:value["reason"].as_str().map(str::to_owned)};
                if let Some(crop)=&row.crop{
                    let mut options=item.options.clone();crop.apply(&mut options);options.validate()?;
                    if crop.face.width<0.01||crop.face.height<0.01{row.crop=None;row.reason=Some("FACE_RESULT_INVALID".into());}
                }
                results.items.push(row);
            }
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            let destination=path(&core,&key)?;std::fs::create_dir_all(destination.parent().unwrap()).map_err(io_error)?;
            project::atomic_write(&destination,&serde_json::to_vec(&results).map_err(io_error)?)
        }.await;
        separation::finish(&core, &app, &key, &outcome);
    });
    Ok(returned)
}
