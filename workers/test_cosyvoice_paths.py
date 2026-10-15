"""Exercise the actual vendor constructor without loading Torch or 5 GB weights."""
import ast
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


class WindowsModelPaths(unittest.TestCase):
    def test_constructor_opens_every_model_asset_with_native_separators(self):
        source = Path(__file__).parent / 'vendor/cosyvoice3/cosyvoice/cli/cosyvoice.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        constructor = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'CosyVoice3')
        constructor.bases = []
        # Includes spaces, Unicode and a >260-character path on Windows.
        base = tempfile.gettempdir()
        if os.name == 'nt':
            base = '\\\\?\\' + base
        with tempfile.TemporaryDirectory(prefix='Cosy models ', dir=base) as temporary:
            directory = Path(temporary) / ('modele-' + 'x' * 90) / ('voix-' + 'y' * 90) / 'fran\u00e7ais'
            directory.mkdir(parents=True)
            names = ['cosyvoice3.yaml', 'campplus.onnx', 'speech_tokenizer_v3.onnx', 'spk2info.pt', 'llm.pt', 'flow.pt', 'hift.pt']
            for name in names:
                (directory / name).write_text('fixture', encoding='utf-8')
            seen = []

            def check(path):
                self.assertTrue(os.path.isfile(path), path)
                seen.append(Path(path).name)

            class Model:
                def __init__(self, *args):
                    pass

                def load(self, *paths):
                    for path in paths:
                        check(path)

            def frontend(_tokenizer, _extractor, *args):
                for path in args[:3]:
                    check(path)

            def yaml(stream, overrides):
                check(stream.name)
                return dict.fromkeys(['get_tokenizer', 'feat_extractor', 'allowed_special', 'sample_rate', 'llm', 'flow', 'hift'])

            namespace = dict(os=os, torch=SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
                             load_hyperpyyaml=yaml, get_model_type=lambda _: Model,
                             CosyVoice3Model=Model, CosyVoiceFrontEnd=frontend)
            exec(compile(ast.Module(body=[constructor], type_ignores=[]), str(source), 'exec'), namespace)
            namespace['CosyVoice3'](str(directory))
            self.assertCountEqual(seen, names)


if __name__ == '__main__':
    unittest.main()
