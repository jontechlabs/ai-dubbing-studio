"""CPU-only diagnostic of real FP8 offload/cache and a tiny Drama model, no production CPU path."""
from pathlib import Path
import sys,json,copy,tempfile
sys.dont_write_bytecode = True
repo=Path(__file__).resolve().parents[1]
import zipfile
core_tmp=tempfile.TemporaryDirectory(prefix='drama-core-')
with zipfile.ZipFile(repo/'workers/vendor/drama3/comfy-core.zip') as archive:archive.extractall(core_tmp.name)
sys.path[:0]=[core_tmp.name,str(repo/'workers/vendor/drama3')]
import comfy.cli_args
comfy.cli_args.args.cpu=True
comfy.cli_args.args.disable_dynamic_vram=True
import torch,comfy.ops,comfy.model_management as mm
from drama3.offload import FP8Experts,ExpertStore,SlotPool
mm.DISABLE_PINNED_MEMORY=True
torch.set_num_threads(4)
torch.manual_seed(42)
original=FP8Experts(16,128,128,device='cpu',dtype=torch.bfloat16)
for name,p in original.named_parameters():
 if 'scale' in name:p.data.fill_(0.05)
 else:p.data.copy_(torch.randn(p.shape).clamp(-2,2).to(torch.float8_e4m3fn))
x=torch.randn(1,128,dtype=torch.bfloat16);ids=torch.tensor([[0,1,2,3,4,5,6,7]]);weights=torch.full((1,8),1/8)
expected=original(x,ids,weights)
store=ExpertStore();offloaded=store.add(original)
store.cache=SlotPool(store.banks[0],0,16,torch.device('cpu'))
assert store.cache.count==8
actual=offloaded(x,ids,weights)
torch.testing.assert_close(actual,expected,rtol=0,atol=0)
offloaded(x,ids,weights);assert store.cache.hits==8
ids2=torch.tensor([[8,9,10,11,12,13,14,15]])
torch.testing.assert_close(offloaded(x,ids2,weights),original(x,ids2,weights),rtol=0,atol=0)
assert len(store.cache.owner)==8
print('PASS: actual FP8 expert math, RAM bank, bounded 8-slot LRU, hits, eviction, correct outputs')
from drama3.config import parse_config
from drama3.model import Drama3Model
from drama3.loader import load_drama3
from drama3.generate import generate
from safetensors.torch import save_file
c=json.loads((repo/'workers/vendor/drama3/drama3/fish/config.json').read_text())
t=c['text_config'];t.update(vocab_size=256,hidden_size=128,num_hidden_layers=4,num_attention_heads=4,num_key_value_heads=2,head_dim=32,linear_num_key_heads=2,linear_num_value_heads=4,linear_key_head_dim=32,linear_value_head_dim=32,num_experts=16,num_experts_per_tok=8,moe_intermediate_size=128,shared_expert_intermediate_size=128,max_position_embeddings=256,layer_types=['linear_attention']*3+['full_attention'])
c.update(eos_token_id=2,semantic_start_token_id=128,semantic_end_token_id=143)
c['audio_decoder_config'].update(dim=128,n_head=4,n_local_heads=2,head_dim=32,intermediate_size=128,num_codebooks=10,vocab_size=16,shared_enrichment_layers=1,vq_backbone_codebooks=2)
conf=parse_config(c);conf.fp8_experts=True
model=Drama3Model(conf,device='cpu',dtype=torch.bfloat16,operations=comfy.ops.manual_cast)
for name,p in model.named_parameters():
 if 'scale' in name:p.data.fill_(0.02)
 elif p.dtype==torch.float8_e4m3fn:p.data.copy_((torch.randn(p.shape)*0.1).to(p.dtype))
 elif name.endswith('weight') and p.ndim==1:p.data.fill_(1)
 else:p.data.copy_(torch.randn(p.shape,dtype=torch.float32).to(p.dtype)*0.02)
with tempfile.TemporaryDirectory() as directory:
 file=Path(directory)/'tiny.safetensors'
 save_file(model.state_dict(),str(file),metadata={'drama3_config':json.dumps(c),'drama3_format':'fp8'})
 loaded=load_drama3(str(file),experts_in_ram=True,expert_cache_gb=0.001)
 assert len(loaded.experts.banks)==4
 assert all(p.device.type!='meta' for p in loaded.model.parameters())
 # Same sampler, attention, DeltaNet, tower and cache as production, at diagnostic scale.
 prompt=torch.zeros((3,11),dtype=torch.long);prompt[:,0]=1
 with torch.inference_mode():
  mm.load_models_gpu(loaded.patchers())
  frames=generate(loaded,prompt,2,1.0,10,.9,42)
 assert frames.shape[1]==11
 assert frames.shape[0]==2
 print('PASS: meta loading + assigned state, FP8 expert offload, full/linear attention and autoregressive codebook generation',tuple(frames.shape))

# Validate all real checkpoint tensor names/shapes against the full meta architecture.
headers=json.loads((repo/'workers/vendor/drama3/checkpoint-headers.json').read_text(encoding='utf-8'))
from drama3.codec import Drama3Codec
for name,header in headers.items():
 if 'codec' in name:
  network=Drama3Codec(device='meta',dtype=torch.float32,operations=comfy.ops.manual_cast)
 else:
  config=parse_config(json.loads(header['__metadata__']['drama3_config']));config.fp8_experts=True
  network=Drama3Model(config,device='meta',dtype=torch.bfloat16,operations=comfy.ops.manual_cast)
 expected={k:list(v.shape) for k,v in network.state_dict().items()}
 actual={k:v['shape'] for k,v in header.items() if k!='__metadata__'}
 assert expected==actual, (name, set(expected)^set(actual))
 assert all(t.device.type=='meta' for t in network.parameters())
 print('PASS: real pinned checkpoint header matches full meta architecture',name,len(expected),'tensors')
core_tmp.cleanup()
