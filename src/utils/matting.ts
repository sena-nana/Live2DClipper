import type { MatteBackground } from '../types/layers';
import { loadImage } from './image';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clamp255 = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

export interface CompositeInput {
  background: MatteBackground;
  url: string;
}

const getImageData = async (url: string, width?: number, height?: number) => {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width ?? image.naturalWidth;
  canvas.height = height ?? image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
};

export const recoverFromEstimate = async (input: CompositeInput) => {
  const imageData = await getImageData(input.url);
  const { data, width, height } = imageData;
  const output = new ImageData(width, height);
  const alpha = new ImageData(width, height);

  for (let index = 0; index < data.length; index += 4) {
    output.data[index] = data[index];
    output.data[index + 1] = data[index + 1];
    output.data[index + 2] = data[index + 2];
    output.data[index + 3] = 255;

    alpha.data[index] = 255;
    alpha.data[index + 1] = 255;
    alpha.data[index + 2] = 255;
    alpha.data[index + 3] = 255;
  }

  return imageDataToUrls(output, alpha);
};

export const recoverFromBlackWhite = async (blackInput: CompositeInput, whiteInput: CompositeInput) => {
  const black = await getImageData(blackInput.url);
  const white = await getImageData(whiteInput.url, black.width, black.height);
  const output = new ImageData(black.width, black.height);
  const alphaImage = new ImageData(black.width, black.height);

  for (let index = 0; index < black.data.length; index += 4) {
    const cb = [black.data[index], black.data[index + 1], black.data[index + 2]];
    const cw = [white.data[index], white.data[index + 1], white.data[index + 2]];
    const diff = ((cw[0] - cb[0]) + (cw[1] - cb[1]) + (cw[2] - cb[2])) / 3 / 255;
    const alpha = clamp01(1 - diff);
    const alpha255 = clamp255(alpha * 255);

    output.data[index] = alpha > 0.001 ? clamp255(cb[0] / alpha) : 0;
    output.data[index + 1] = alpha > 0.001 ? clamp255(cb[1] / alpha) : 0;
    output.data[index + 2] = alpha > 0.001 ? clamp255(cb[2] / alpha) : 0;
    output.data[index + 3] = alpha255;

    alphaImage.data[index] = alpha255;
    alphaImage.data[index + 1] = alpha255;
    alphaImage.data[index + 2] = alpha255;
    alphaImage.data[index + 3] = 255;
  }

  return imageDataToUrls(output, alphaImage);
};

export const recoverFromMultiBackground = async (inputs: CompositeInput[]) => {
  if (inputs.length < 2) {
    throw new Error('多背景最小二乘至少需要两张背景图');
  }

  const first = await getImageData(inputs[0].url);
  const imageDatas = [first];
  for (const input of inputs.slice(1)) {
    imageDatas.push(await getImageData(input.url, first.width, first.height));
  }

  const output = new ImageData(first.width, first.height);
  const alphaImage = new ImageData(first.width, first.height);
  const referenceBackground = inputs[0].background.rgb;
  const referenceData = imageDatas[0].data;

  for (let index = 0; index < first.data.length; index += 4) {
    let numerator = 0;
    let denominator = 0;

    for (let inputIndex = 1; inputIndex < inputs.length; inputIndex += 1) {
      const bg = inputs[inputIndex].background.rgb;
      const data = imageDatas[inputIndex].data;

      for (let channel = 0; channel < 3; channel += 1) {
        const compositeDelta = data[index + channel] - referenceData[index + channel];
        const backgroundDelta = bg[channel] - referenceBackground[channel];
        numerator += compositeDelta * backgroundDelta;
        denominator += backgroundDelta * backgroundDelta;
      }
    }

    const transparency = denominator > 0 ? numerator / denominator : 0;
    const alpha = clamp01(1 - transparency);
    const alpha255 = clamp255(alpha * 255);

    for (let channel = 0; channel < 3; channel += 1) {
      const foreground =
        alpha > 0.001
          ? (referenceData[index + channel] - (1 - alpha) * referenceBackground[channel]) / alpha
          : 0;
      output.data[index + channel] = clamp255(foreground);
    }

    output.data[index + 3] = alpha255;
    alphaImage.data[index] = alpha255;
    alphaImage.data[index + 1] = alpha255;
    alphaImage.data[index + 2] = alpha255;
    alphaImage.data[index + 3] = 255;
  }

  return imageDataToUrls(output, alphaImage);
};

export const recoverFromModelAlpha = async (colorUrl: string, alphaUrl: string) => {
  const color = await getImageData(colorUrl);
  const alpha = await getImageData(alphaUrl, color.width, color.height);
  const output = new ImageData(color.width, color.height);
  const alphaImage = new ImageData(color.width, color.height);

  for (let index = 0; index < color.data.length; index += 4) {
    const alphaValue = clamp255((alpha.data[index] + alpha.data[index + 1] + alpha.data[index + 2]) / 3);

    output.data[index] = color.data[index];
    output.data[index + 1] = color.data[index + 1];
    output.data[index + 2] = color.data[index + 2];
    output.data[index + 3] = alphaValue;

    alphaImage.data[index] = alphaValue;
    alphaImage.data[index + 1] = alphaValue;
    alphaImage.data[index + 2] = alphaValue;
    alphaImage.data[index + 3] = 255;
  }

  return imageDataToUrls(output, alphaImage);
};

const imageDataToUrls = (rgba: ImageData, alpha: ImageData) => {
  const rgbaCanvas = document.createElement('canvas');
  rgbaCanvas.width = rgba.width;
  rgbaCanvas.height = rgba.height;
  rgbaCanvas.getContext('2d')?.putImageData(rgba, 0, 0);

  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = alpha.width;
  alphaCanvas.height = alpha.height;
  alphaCanvas.getContext('2d')?.putImageData(alpha, 0, 0);

  return {
    rgbaUrl: rgbaCanvas.toDataURL('image/png'),
    alphaUrl: alphaCanvas.toDataURL('image/png'),
  };
};
