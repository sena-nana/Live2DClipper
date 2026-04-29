let counter = 0;

export const createId = (prefix: string) => {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
};
