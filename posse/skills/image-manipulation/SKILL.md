---
name: image-manipulation
description: Inspect and compare deterministic image preprocessing when building or improving image-based experiments, including geometry, OCR crops, masks and noise reduction.
---

This suite is attached to your specific role in this test, not to other agents.
Use `image.tools` to discover operations and their exact parameter schemas. Use
`test.corpus_cases` to select a source by `case_index` and resource `alias`.
`image.transform` accepts up to four named recipes in one call. Every recipe
starts from the same source; steps within it run in order. An empty recipe previews
the original. Set `preview:false` when only an artifact receipt is needed.

Start by inspecting the original and the relevant crop. Compare a small number of
hypotheses in a batch: grayscale, light Gaussian blur, fixed/Otsu/local threshold,
or a small morphological kernel. Blur can reduce edge noise but erase small text;
opening removes small bright specks, closing fills small dark holes. Global
thresholds can fail with uneven illumination. Sobel here is a diagnostic operation,
not the production scanner's Canny implementation.

For geometry, rectify a convex quad ordered top-left, top-right, bottom-right,
bottom-left. All coordinates are pixels in the current step's input; crop/resize
change that coordinate space. Preserve aspect ratio when resizing unless changing
it is deliberate. A quad mask changes the outside background without inferring
which object is the card. Background removal here is geometric, not generative.

Recipes return hashes, input/output dimensions and operation traces. Derived
artifacts can be chained by hash within the current agent session. They are bounded
and expire with that session; originals remain immutable. Previews may be scaled
for delivery; receipts retain full dimensions and a separate preview hash. Do not
paste image bytes into notes; retain recipe parameters and the concrete finding.

These tools help investigate. Their artifacts are not substituted into benchmark
inputs and visual preference is not a score. To measure an improvement, implement
a general preprocessing change in the allowed production code and rerun the frozen
suite. A backend test that replays frozen OCR cannot measure image-processing
improvements. Keep answer keys out of preprocessing and do not tune per-card rules.
