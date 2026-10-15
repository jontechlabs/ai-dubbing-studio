"""Load the official inference configuration without instantiating training jobs."""
import io

INFERENCE_KEYS = {
    'sample_rate', 'llm_input_size', 'llm_output_size', 'spk_embed_dim',
    'qwen_pretrain_path', 'token_frame_rate', 'token_mel_ratio', 'chunk_size',
    'num_decoding_left_chunks', 'llm', 'flow', 'hift', 'get_tokenizer',
    'feat_extractor', 'allowed_special',
}


def inference_yaml(stream, overrides=None):
    from ruamel.yaml import YAML
    from hyperpyyaml import load_hyperpyyaml
    yaml = YAML(typ='rt')
    source = yaml.load(stream)
    for key in list(source):
        if key not in INFERENCE_KEYS:
            del source[key]
    output = io.StringIO()
    yaml.dump(source, output)
    output.seek(0)
    return load_hyperpyyaml(output, overrides=overrides)
