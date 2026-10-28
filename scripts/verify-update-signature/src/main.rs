use base64::Engine;
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let config: serde_json::Value=serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    let decode=|value:&str|String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value.trim()).unwrap()).unwrap();
    let public=minisign_verify::PublicKey::decode(&decode(config["plugins"]["updater"]["pubkey"].as_str().unwrap())).unwrap();
    let signature=minisign_verify::Signature::decode(&decode(&std::fs::read_to_string(&args[3]).unwrap())).unwrap();
    let mut artifact=std::fs::read(&args[2]).unwrap();
    public.verify(&artifact,&signature,false).unwrap();
    artifact[0]^=1;assert!(public.verify(&artifact,&signature,false).is_err());
    println!("Updater signature verified; modified installer rejected.");
}
