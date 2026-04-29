export const dataUrlToBlob = async (dataUrl: string) => {
  const response = await fetch(dataUrl);
  return response.blob();
};

export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export const remoteImageToDataUrl = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`图片下载失败：${response.status}`);
  }

  return blobToDataUrl(await response.blob());
};
