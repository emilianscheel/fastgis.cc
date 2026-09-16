const MODEL_URL = new URL("./model.json", import.meta.url);

let modelPromise;

const shaderCode = `
struct Config {
  rows: u32,
  seed: u32,
  padding0: u32,
  padding1: u32,
}

@group(0) @binding(0) var<storage, read_write> deltas: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> params: array<f32>;
@group(0) @binding(2) var<uniform> config: Config;

fn hash(value: u32) -> u32 {
  var x = value;
  x = (x ^ 61u) ^ (x >> 16u);
  x = x * 9u;
  x = x ^ (x >> 4u);
  x = x * 0x27d4eb2du;
  return x ^ (x >> 15u);
}

fn uniform(seed: u32, index: u32) -> f32 {
  return (f32(hash(seed ^ (index * 0x9e3779b9u))) + 0.5) / 4294967296.0;
}

fn gaussian(seed: u32, index: u32) -> vec2<f32> {
  let u1 = max(uniform(seed, index * 2u), 1e-7);
  let u2 = uniform(seed, index * 2u + 1u);
  let radius = sqrt(-2.0 * log(u1));
  let angle = 6.283185307179586 * u2;
  return vec2<f32>(radius * cos(angle), radius * sin(angle));
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x != 0u || config.rows == 0u) {
    return;
  }

  let center = vec2<f32>(params[0], params[1]);
  let l00 = params[2];
  let l10 = params[3];
  let l11 = params[4];
  let persistence = params[5];
  let innovationScale = sqrt(max(0.0, 1.0 - persistence * persistence));

  var random = gaussian(config.seed, 0u);
  var state = center + vec2<f32>(
    l00 * random.x,
    l10 * random.x + l11 * random.y
  );
  deltas[0] = state;

  for (var index = 1u; index < config.rows; index++) {
    random = gaussian(config.seed, index);
    let innovation = innovationScale * vec2<f32>(
      l00 * random.x,
      l10 * random.x + l11 * random.y
    );
    state = center + persistence * (state - center) + innovation;
    deltas[index] = state;
  }
}
`;

async function loadModel() {
  modelPromise ??= fetch(MODEL_URL).then((response) => {
    if (!response.ok) {
      throw new Error(`Could not load GNSS model: ${response.status}`);
    }
    return response.json();
  });
  return modelPromise;
}

function parseTrajectory(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error("The trajectory must contain a header and at least one row");
  }
  if (lines[0].replace(/\s/g, "") !== "timestamp,latitude,longitude") {
    throw new Error("Expected CSV header: timestamp,latitude,longitude");
  }

  return lines.slice(1).map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 3) {
      throw new Error(`Invalid CSV row ${index + 2}`);
    }
    const latitude = Number(columns[1]);
    const longitude = Number(columns[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Invalid coordinates on CSV row ${index + 2}`);
    }
    return { timestamp: columns[0], latitude, longitude };
  });
}

function selectRegime(regimes, value) {
  let cumulative = 0;
  for (const regime of regimes) {
    cumulative += regime.weight;
    if (value < cumulative) {
      return regime;
    }
  }
  return regimes.at(-1);
}

function cholesky(covariance) {
  const l00 = Math.sqrt(Math.max(covariance[0][0], 0));
  const l10 = l00 === 0 ? 0 : covariance[1][0] / l00;
  const l11 = Math.sqrt(Math.max(covariance[1][1] - l10 * l10, 0));
  return [l00, l10, l11];
}

function randomSeed() {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  return seed[0];
}

function seedFraction(seed) {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

/**
 * Adds learned GNSS noise to a perfect timestamp,latitude,longitude CSV.
 *
 * @param {string} perfectCsv
 * @param {{seed?: number}} options Pass a seed for reproducible output.
 * @returns {Promise<string>} A noisy timestamp,latitude,longitude CSV.
 */
export async function addGnssNoise(perfectCsv, options = {}) {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this browser");
  }

  const rows = parseTrajectory(perfectCsv);
  const seed = (options.seed ?? randomSeed()) >>> 0;
  const model = await loadModel();
  const regime = selectRegime(model.regimes, seedFraction(seed));
  const [l00, l10, l11] = cholesky(regime.covariance);
  const parameters = new Float32Array([
    regime.center[0],
    regime.center[1],
    l00,
    l10,
    l11,
    regime.persistence,
    0,
    0,
  ]);

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter is available");
  }
  const device = await adapter.requestDevice();
  const byteLength = rows.length * 2 * Float32Array.BYTES_PER_ELEMENT;
  if (byteLength > device.limits.maxStorageBufferBindingSize) {
    device.destroy();
    throw new Error("The trajectory is too large for this WebGPU device");
  }

  const outputBuffer = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const parameterBuffer = device.createBuffer({
    size: parameters.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const configBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readBuffer = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  device.queue.writeBuffer(parameterBuffer, 0, parameters);
  device.queue.writeBuffer(
    configBuffer,
    0,
    new Uint32Array([rows.length, seed, 0, 0]),
  );

  const shaderModule = device.createShaderModule({ code: shaderCode });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: outputBuffer } },
      { binding: 1, resource: { buffer: parameterBuffer } },
      { binding: 2, resource: { buffer: configBuffer } },
    ],
  });

  const commands = device.createCommandEncoder();
  const pass = commands.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  commands.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, byteLength);
  device.queue.submit([commands.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const deltas = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  outputBuffer.destroy();
  parameterBuffer.destroy();
  configBuffer.destroy();
  readBuffer.destroy();
  device.destroy();

  const output = ["timestamp,latitude,longitude"];
  for (let index = 0; index < rows.length; index++) {
    output.push(
      `${rows[index].timestamp},` +
        `${(rows[index].latitude + deltas[index * 2]).toFixed(9)},` +
        `${(rows[index].longitude + deltas[index * 2 + 1]).toFixed(9)}`,
    );
  }
  return `${output.join("\n")}\n`;
}
