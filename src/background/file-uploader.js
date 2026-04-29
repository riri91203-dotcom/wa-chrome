/**
 * background/file-uploader.js
 *
 * 当前阶段主要解决：
 * 1. 根据后端返回的 fileUrl 下载文件
 * 2. 转成 base64 / DataURL
 * 3. 返回给 content script，由 content script 注入 WhatsApp 页面发送
 *
 * 这里做“文件下载与转码桥接”
 */

/**
 * Blob 转 DataURL(base64)
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("FileReader failed while converting blob to base64"));

    reader.readAsDataURL(blob);
  });
}

/**
 * 根据 URL 下载文件
 * @param {string} fileUrl
 * @returns {Promise<Response>}
 */
async function fetchFile(fileUrl) {
  const response = await fetch(fileUrl, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
  }

  return response;
}

/**
 * 从响应头中提取文件名
 * @param {Response} response
 * @param {string} fallbackName
 * @returns {string}
 */
function resolveFileName(response, fallbackName = "file.pdf") {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);

  if (match) {
    return decodeURIComponent(match[1] || match[2] || fallbackName);
  }

  return fallbackName;
}

/**
 * 下载文件并返回发送所需的数据
 * @param {Object} params
 * @param {string} params.fileUrl
 * @param {string} [params.fileName]
 * @param {string} [params.fileType]
 * @returns {Promise<Object>}
 */
export async function downloadFileAsBase64(params = {}) {
  const { fileUrl, fileName = "manual.pdf", fileType = "pdf" } = params;

  if (!fileUrl) {
    throw new Error("fileUrl is required");
  }

  const response = await fetchFile(fileUrl);
  const blob = await response.blob();
  const finalName = fileName || resolveFileName(response, "manual.pdf");
  const dataUrl = await blobToDataUrl(blob);

  return {
    fileName: finalName,
    fileType,
    mimeType: blob.type || "application/pdf",
    size: blob.size || 0,
    dataUrl
  };
}

/**
 * 仅获取文件元信息，不转 base64
 * 后续如果你想改成 content 侧自己下载，可以复用这个接口
 *
 * @param {Object} params
 * @param {string} params.fileUrl
 * @param {string} [params.fileName]
 * @param {string} [params.fileType]
 * @returns {Promise<Object>}
 */
export async function inspectRemoteFile(params = {}) {
  const { fileUrl, fileName = "manual.pdf", fileType = "pdf" } = params;

  if (!fileUrl) {
    throw new Error("fileUrl is required");
  }

  const response = await fetchFile(fileUrl);
  const blob = await response.blob();

  return {
    fileName: fileName || resolveFileName(response, "manual.pdf"),
    fileType,
    mimeType: blob.type || "application/octet-stream",
    size: blob.size || 0
  };
}