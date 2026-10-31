const safeText = value => String(value || "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const gib = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function imageGpuInventory(capability, version = "unknown") {
  const gpu = capability?.gpu;
  if (!gpu || !Array.isArray(gpu.devices)) {
    throw new Error(`posse-ml ${version} does not provide image GPU discovery. Update the native runtime to a GPU-enabled build.`);
  }
  for (const device of gpu.devices) {
    if (typeof device.id !== "string" || !/^[A-Za-z0-9:_.-]{1,256}$/.test(device.id)
      || typeof device.name !== "string" || typeof device.backend !== "string"
      || !Number.isSafeInteger(device.memoryFree) || device.memoryFree < 0
      || !Number.isSafeInteger(device.memoryTotal) || device.memoryTotal < 0) {
      throw new Error("Native runtime returned invalid GPU metadata.");
    }
  }
  return gpu;
}

export function writeImageGpuInventory(capability, version, stdout, json) {
  const gpu = imageGpuInventory(capability, version);
  if (json) { stdout.write(JSON.stringify({ runtimeVersion: version, ...gpu }) + "\n"); return; }
  stdout.write(`Image GPUs (${safeText(gpu.backend)}; posse-ml ${safeText(version)})\n`);
  for (const device of gpu.devices) {
    stdout.write(`${device.id}\n  ${safeText(device.name)} — ${safeText(device.backend)}, ${gib(device.memoryFree)} free / ${gib(device.memoryTotal)} total${device.integrated ? " (shared memory)" : ""}\n`);
    if (device.idStability !== "hardware") stdout.write("  Enumeration ID: look it up again after changing GPUs or driver configuration.\n");
  }
  if (!gpu.devices.length) stdout.write("No usable image GPUs found. Check the graphics driver and runtime backend.\n");
  if (gpu.discoveryError) stdout.write(`Discovery: ${safeText(gpu.discoveryError)}\n`);
  if (gpu.devices.length) stdout.write("Select: posse local --model qwen-image --gpu-id <ID> --prompt TEXT --output image.png\n");
}

export async function selectImageGpu(capability, args, { version, stdin, stderr, askChoice }) {
  const gpu = imageGpuInventory(capability, version);
  if (gpu.memoryPolicy?.mode !== "auto-fit" || gpu.memoryPolicy?.capGiB !== true) throw new Error(`posse-ml ${version} does not provide GPU memory budgeting. Update the native runtime before GPU generation.`);
  if (args["gpu-id"] !== undefined) {
    const matches = gpu.devices.filter(device => device.id === args["gpu-id"]);
    if (matches.length !== 1) throw new Error(`GPU ID ${JSON.stringify(args["gpu-id"])} is ${matches.length ? "ambiguous" : "unavailable"}. Run posse local gpus again.`);
    return matches[0];
  }
  if (!gpu.devices.length) throw new Error(`No usable image GPU was found.${gpu.discoveryError ? ` ${safeText(gpu.discoveryError)}` : ""} Run posse local gpus and check the GPU driver.`);
  if (gpu.devices.length === 1) return gpu.devices[0];
  if (args["non-interactive"] || !stdin.isTTY || !stderr.isTTY) throw new Error("Multiple GPUs are available. Run posse local gpus and select one with --gpu-id <ID>.");
  const ask = askChoice || (await import("./input-prompts.js")).askSelectorChoice;
  const id = await ask("Choose the image GPU", [{ value: "cancel", label: "Cancel" },
    ...gpu.devices.map(device => ({ value: device.id, label: `${safeText(device.name)} — ${device.id} (${gib(device.memoryFree)} free)` }))],
  { defaultValue: "cancel", input: stdin, output: stderr });
  const chosen = gpu.devices.find(device => device.id === id);
  if (!chosen) throw new DOMException("GPU selection canceled", "AbortError");
  return chosen;
}
