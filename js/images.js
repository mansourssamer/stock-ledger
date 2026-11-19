// Photos are shrunk to phone size (JPEG, under about 900 KB) so each fits in one free
// database document.
export async function shrinkImage(bytes, name) {
  const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  let max = 1100, q = 0.78, url = '';
  for (let i = 0; i < 5; i++) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', q);
    if (url.length < 900 * 1024) return { data: url, w: c.width, h: c.height, bytes: Math.round(url.length * 0.75) };
    max = Math.round(max * 0.75); q -= 0.08;
  }
  return { data: url, bytes: Math.round(url.length * 0.75) };
}
