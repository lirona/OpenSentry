export function buildSourceBundle(files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('buildSourceBundle: files must be a non-empty array');
  }

  const normalizedFiles = files.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError(`buildSourceBundle: files[${index}] must be an object`);
    }
    if (typeof file.name !== 'string' || file.name.length === 0) {
      throw new TypeError(`buildSourceBundle: files[${index}].name must be a non-empty string`);
    }
    if (typeof file.content !== 'string') {
      throw new TypeError(`buildSourceBundle: files[${index}].content must be a string`);
    }
    return { name: file.name, content: file.content };
  });

  if (normalizedFiles.length === 1 && options.forceHeaders !== true) {
    return {
      files: normalizedFiles,
      combinedSource: normalizedFiles[0].content,
    };
  }

  const combinedSource = normalizedFiles
    .map((file) => `// === File: ${file.name} ===\n${file.content}\n`)
    .join('\n');

  return { files: normalizedFiles, combinedSource };
}

export function inferContractNameFromFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    return 'Contract';
  }
  return fileName.replace(/\.[^.]+$/, '') || 'Contract';
}
