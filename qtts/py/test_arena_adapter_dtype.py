"""Real-PyTorch regressions for frozen-adapter dtype and numerical equivalence.

The default dependency-light unit run skips these when PyTorch is unavailable.
They are tensor/core contract tests, not model-quality or Kaggle audio evidence.
"""
from __future__ import annotations

import copy
import importlib.util
import unittest

try:
    import torch
except (ImportError, OSError):
    torch = None


@unittest.skipIf(torch is None, "real PyTorch is not installed in the dependency-light unit runtime")
class FrozenAdapterDtypeTests(unittest.TestCase):
    def test_frozen_buffers_match_trainable_parameters_exactly(self):
        from torch import nn
        from lora_adapter import LoRALinear

        torch.manual_seed(17)
        base = nn.Linear(6, 5, bias=False).half()
        trainable = LoRALinear(copy.deepcopy(base), rank=2, alpha=4)
        frozen = LoRALinear(copy.deepcopy(base), rank=2, alpha=4, trainable=False)
        a = torch.randn(2, 6, dtype=torch.float32) * 0.01
        b = torch.randn(5, 2, dtype=torch.float32) * 0.01
        with torch.no_grad():
            for layer in (trainable, frozen):
                layer.lora_A.copy_(a)
                layer.lora_B.copy_(b)

        self.assertIsInstance(trainable.lora_A, nn.Parameter)
        self.assertIsInstance(trainable.lora_B, nn.Parameter)
        self.assertNotIsInstance(frozen.lora_A, nn.Parameter)
        self.assertNotIsInstance(frozen.lora_B, nn.Parameter)
        self.assertEqual(frozen.lora_A.dtype, torch.float32)
        self.assertEqual(frozen.lora_B.dtype, torch.float32)
        self.assertIn("lora_A", dict(frozen.named_buffers()))
        self.assertIn("lora_B", dict(frozen.named_buffers()))
        self.assertNotIn("lora_A", dict(frozen.named_parameters()))
        self.assertNotIn("lora_B", dict(frozen.named_parameters()))

        inputs = torch.randn(3, 4, 6, dtype=torch.float16)
        with torch.no_grad():
            expected = trainable(inputs)
            actual = frozen(inputs)
        self.assertEqual(actual.dtype, torch.float16)
        self.assertTrue(torch.equal(actual, expected), "frozen inference changed LoRA arithmetic")

    @unittest.skipIf(importlib.util.find_spec("transformers") is None, "Transformers is not installed")
    def test_prepare_adapter_preserves_pretrained_model_dtype_and_speaker_path(self):
        from torch import nn
        from transformers import PreTrainedModel, PretrainedConfig
        from lora_adapter import commit_adapter, prepare_adapter

        class TinyTalker(PreTrainedModel):
            def __init__(self):
                super().__init__(PretrainedConfig())
                # Qwen registers decoder layers before codec/text embeddings.
                # PreTrainedModel.dtype therefore observes the first FP32 LoRA
                # Parameter in the buggy implementation, not the FP16 Base.
                self.self_attn = nn.Module()
                self.self_attn.q_proj = nn.Linear(4, 4, bias=False)
                self.codec_embedding = nn.Embedding(8, 4)

        class TinyCore(nn.Module):
            def __init__(self):
                super().__init__()
                self.talker = TinyTalker()

        core = TinyCore().half().eval()
        targets = ["talker.self_attn.q_proj"]
        weights = {
            "talker.self_attn.q_proj.lora_A": (torch.randn(2, 4) * 0.01).numpy(),
            "talker.self_attn.q_proj.lora_B": (torch.randn(4, 2) * 0.01).numpy(),
        }
        commit_adapter(core, prepare_adapter(core, weights, targets, rank=2, alpha=4))

        self.assertEqual(core.talker.codec_embedding.weight.dtype, torch.float16)
        self.assertEqual(core.talker.dtype, torch.float16)
        layer = core.talker.self_attn.q_proj
        self.assertEqual(layer.lora_A.dtype, torch.float32)
        self.assertEqual(layer.lora_B.dtype, torch.float32)
        self.assertNotIsInstance(layer.lora_A, nn.Parameter)
        self.assertNotIsInstance(layer.lora_B, nn.Parameter)

        # This is the fixed upstream contract: generate_speaker_prompt casts to
        # talker.dtype, then concatenates with codec embeddings before q_proj.
        speaker = torch.randn(4, dtype=torch.float32).to(core.talker.dtype)
        codec = core.talker.codec_embedding(torch.tensor([[1, 2]], dtype=torch.long))
        mixed = torch.cat((codec, speaker.view(1, 1, -1)), dim=1)
        self.assertEqual(mixed.dtype, torch.float16)
        with torch.no_grad():
            output = layer(mixed)
        self.assertEqual(output.dtype, torch.float16)

        # Rebinding another profile must retain the same invariant.
        replacement = {name: value.copy() for name, value in weights.items()}
        commit_adapter(core, prepare_adapter(core, replacement, targets, rank=2, alpha=4))
        self.assertEqual(core.talker.dtype, torch.float16)
        self.assertEqual(core.talker.self_attn.q_proj.lora_A.dtype, torch.float32)


if __name__ == "__main__":
    unittest.main()
