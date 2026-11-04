const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pluginName =
  process.platform === 'win32'
    ? 'protoc-gen-ts_proto.cmd'
    : 'protoc-gen-ts_proto';
const pluginPath = path.join(root, 'node_modules', '.bin', pluginName);
const protoDirectory = path.join(root, 'libs', 'contracts', 'src', 'proto');
const outputDirectory = path.join(root, 'libs', 'contracts', 'src');

const result = spawnSync(
  'protoc',
  [
    `--plugin=protoc-gen-ts_proto=${pluginPath}`,
    `--ts_proto_out=${outputDirectory}`,
    '--ts_proto_opt=onlyTypes=true',
    `--proto_path=${protoDirectory}`,
    path.join(protoDirectory, 'order.proto'),
    path.join(protoDirectory, 'catalog.proto'),
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
