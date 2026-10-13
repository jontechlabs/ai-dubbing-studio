"""Device selection must test usable kernels, not only enumerate adapters."""
import types
import unittest
from unittest.mock import patch
from bandit_worker import device_info, select_device


class DeviceTests(unittest.TestCase):
    def inventory(self, count=0, failing=()):
        class Tensor:
            def __init__(self, device): self.device = device
            def add_(self, _):
                if self.device in failing:
                    raise RuntimeError("no kernel image is available for execution on the device")
                return self
        fake = types.SimpleNamespace(
            version=types.SimpleNamespace(cuda="12.8" if count else None),
            ones=lambda _, device: Tensor(device),
            cuda=types.SimpleNamespace(
                is_available=lambda: bool(count), device_count=lambda: count,
                get_device_name=lambda index: f"NVIDIA GPU {index}",
                synchronize=lambda _: None,
            ),
        )
        with patch.dict("sys.modules", {"torch": fake}):
            return device_info()

    def test_cpu_installation_remains_available(self):
        info = self.inventory()
        self.assertEqual(info["devices"], [{"id": "cpu", "name": "CPU"}])
        self.assertEqual(select_device("auto", info["devices"]), "cpu")
        self.assertIsNone(info["cudaVersion"])

    def test_detected_but_incompatible_gpu_is_not_offered(self):
        info = self.inventory(1, ("cuda:0",))
        self.assertEqual(select_device("auto", info["devices"]), "cpu")
        self.assertEqual(info["unavailableDevices"][0]["id"], "cuda:0")
        with self.assertRaisesRegex(ValueError, "DEVICE_UNAVAILABLE"):
            select_device("cuda:0", info["devices"])

    def test_auto_uses_first_usable_gpu_even_if_gpu_zero_fails(self):
        info = self.inventory(2, ("cuda:0",))
        self.assertEqual(select_device("auto", info["devices"]), "cuda:1")

    def test_explicit_cpu_and_cuda_are_respected(self):
        info = self.inventory(2)
        self.assertEqual(select_device("cpu", info["devices"]), "cpu")
        self.assertEqual(select_device("cuda:1", info["devices"]), "cuda:1")
        self.assertEqual(info["unavailableDevices"], [])


if __name__ == "__main__":
    unittest.main()
