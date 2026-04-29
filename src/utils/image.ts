export const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });

export const createSolidImage = (width: number, height: number, color: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D');
  }

  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png');
};

export const createCheckerImage = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D');
  }

  const size = Math.max(12, Math.round(Math.min(width, height) / 28));
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      context.fillStyle = (x / size + y / size) % 2 === 0 ? '#51545d' : '#24262d';
      context.fillRect(x, y, size, size);
    }
  }

  return canvas.toDataURL('image/png');
};
