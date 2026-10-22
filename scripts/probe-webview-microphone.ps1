# Standalone Windows/WebView2 diagnostic; synthetic input only, no user audio.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$repo=Split-Path -Parent $PSScriptRoot
$work=Join-Path $repo '.cache/webview-microphone-probe'
New-Item -ItemType Directory -Force $work | Out-Null
$archive=Join-Path $work 'webview2.zip'
Invoke-WebRequest -UseBasicParsing 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg' -OutFile $archive
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'){throw 'SDK checksum mismatch'}
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'sdk') -Force
$env:PATH=(Join-Path $work 'sdk/runtimes/win-x64/native')+';'+$env:PATH
[Reflection.Assembly]::LoadFrom((Join-Path $work 'sdk/lib/net462/Microsoft.Web.WebView2.Core.dll')) | Out-Null
[Reflection.Assembly]::LoadFrom((Join-Path $work 'sdk/lib/net462/Microsoft.Web.WebView2.WinForms.dll')) | Out-Null
$wav=Join-Path $work 'input.wav'
$writer=[IO.BinaryWriter]::new([IO.File]::Create($wav))
try {
    $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$writer.Write([uint32]48036);$writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$writer.Write([uint32]16);$writer.Write([uint16]1);$writer.Write([uint16]1);$writer.Write([uint32]24000);$writer.Write([uint32]48000);$writer.Write([uint16]2);$writer.Write([uint16]16);$writer.Write([Text.Encoding]::ASCII.GetBytes('data'));$writer.Write([uint32]48000)
    for($i=0;$i -lt 24000;$i++){$writer.Write([int16]([Math]::Sin($i/24000*440*2*[Math]::PI)*6000))}
} finally {$writer.Dispose()}
$policy=(Get-Content -LiteralPath (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).app.security.csp
[IO.File]::WriteAllText((Join-Path $work 'index.html'),"<html><head><meta http-equiv=`"Content-Security-Policy`" content=`"$policy`"></head><body><script src=`"probe.js`"></script></body></html>",[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $repo 'public/microphone-worklet.js') -Destination $work
$javascript=@'
const violations=[];
document.addEventListener('securitypolicyviolation',e=>violations.push({directive:e.violatedDirective,blocked:e.blockedURI}));
let stage='getUserMedia',stream,context,node;
const post=data=>chrome.webview.postMessage({...data,stage,violations,origin:location.origin,secure:isSecureContext});
(async()=>{
  try {
    stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    post({event:'stream',settings:stream.getAudioTracks()[0].getSettings()});
    stage='AudioContext';context=new AudioContext({sampleRate:24000});post({event:'context',rate:context.sampleRate});
    stage='worklet';await context.audioWorklet.addModule('/microphone-worklet.js');
    node=new AudioWorkletNode(context,'studio-microphone',{channelCount:1,channelCountMode:'explicit'});
    let frames=0,peak=0;
    node.port.onmessage=e=>{if(e.data.samples){frames+=e.data.samples.length;for(const value of e.data.samples)peak=Math.max(peak,Math.abs(value));if(frames>=24000){post({done:true,ok:peak>.001,frames,peak});stream.getTracks().forEach(t=>t.stop());context.close();}}};
    const source=context.createMediaStreamSource(stream),gain=context.createGain();gain.gain.value=0;source.connect(node);node.connect(gain);gain.connect(context.destination);
    stage='resume';await context.resume();stage='recording';
  }catch(e){post({done:true,ok:false,error:e.name+': '+e.message});stream?.getTracks().forEach(t=>t.stop());context?.close();}
})();
'@
[IO.File]::WriteAllText((Join-Path $work 'probe.js'),$javascript,[Text.UTF8Encoding]::new($false))
$script:result=Join-Path $work 'result.json'
$script:form=[Windows.Forms.Form]::new();$script:form.ShowInTaskbar=$false;$script:form.Opacity=0;$script:form.Width=640;$script:form.Height=480
$script:web=[Microsoft.Web.WebView2.WinForms.WebView2]::new();$script:web.Dock=[Windows.Forms.DockStyle]::Fill
$properties=[Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties]::new();$properties.UserDataFolder=Join-Path $work 'profile';$properties.AdditionalBrowserArguments="--autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=`"$wav`""
$script:web.CreationProperties=$properties;$script:form.Controls.Add($script:web)
$script:web.add_CoreWebView2InitializationCompleted({
    param($sender,$eventArgs)
    if(-not $eventArgs.IsSuccess){[IO.File]::WriteAllText($script:result,($eventArgs.InitializationException | Out-String));$script:form.Close();return}
    $script:web.CoreWebView2.SetVirtualHostNameToFolderMapping('studio.localhost',$work,[Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind]::Allow)
    $script:web.CoreWebView2.add_WebMessageReceived({param($sender,$eventArgs)
        $message=$eventArgs.WebMessageAsJson;Write-Output $message
        $data=$message | ConvertFrom-Json
        if($data.done){[IO.File]::WriteAllText($script:result,$message);$script:form.Close()}
    })
    $script:web.CoreWebView2.Navigate('http://studio.localhost/index.html')
})
$script:form.add_Shown({$null=$script:web.EnsureCoreWebView2Async()})
$timer=[Windows.Forms.Timer]::new();$timer.Interval=45000;$timer.add_Tick({[IO.File]::WriteAllText($script:result,'{"ok":false,"error":"timeout"}');$script:form.Close()});$timer.Start()
try {[Windows.Forms.Application]::Run($script:form)}finally{$timer.Stop();$timer.Dispose();$script:web.Dispose();$script:form.Dispose()}
Get-Content -LiteralPath $script:result -Raw
if(-not ((Get-Content -LiteralPath $script:result -Raw | ConvertFrom-Json).ok)){throw 'WebView2 microphone probe failed'}
