import { writePsd } from 'ag-psd';
import type { LayerNode } from '../types/layers';
import { flattenTree } from '../utils/tree';
import { loadImage } from '../utils/image';
import { isExportablePsdLayer } from '../utils/layerTasks';

const dataUrlToCanvas = async (url: string) => {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D');
  }

  context.drawImage(image, 0, 0);
  return canvas;
};

export const exportLayersToPsd = async (
  projectName: string,
  sourceImageUrl: string | null,
  layers: LayerNode[],
) => {
  const flatLayers = flattenTree(layers).filter(isExportablePsdLayer);
  const canvases = await Promise.all(flatLayers.map((layer) => dataUrlToCanvas(layer.imageUrl ?? '')));
  const sourceCanvas = sourceImageUrl ? await dataUrlToCanvas(sourceImageUrl) : canvases[0];
  const width = sourceCanvas?.width ?? 1024;
  const height = sourceCanvas?.height ?? 1024;

  const psd = {
    width,
    height,
    children: flatLayers.map((layer, index) => ({
      name: layer.name,
      canvas: canvases[index],
      opacity: Math.round(layer.opacity * 255),
      hidden: !layer.visible,
    })),
  };

  const buffer = writePsd(psd);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${projectName || 'live2d-clipper'}.psd`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
