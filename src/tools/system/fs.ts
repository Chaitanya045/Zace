import {
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  statSync as nodeStatSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import {
  access as nodeAccess,
  appendFile as nodeAppendFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";

export {
  nodeAccess as fsAccess,
  nodeAppendFile as fsAppendFile,
  nodeMkdir as fsMkdir,
  nodeMkdirSync as fsMkdirSync,
  nodeReadFile as fsReadFile,
  nodeReadFileSync as fsReadFileSync,
  nodeReaddir as fsReaddir,
  nodeReaddirSync as fsReaddirSync,
  nodeStat as fsStat,
  nodeStatSync as fsStatSync,
  nodeWriteFile as fsWriteFile,
  nodeWriteFileSync as fsWriteFileSync,
};
