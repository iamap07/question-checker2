import type { NextConfig } from 'next';
const nextConfig: NextConfig = { experimental: { typedRoutes: true }, serverExternalPackages: ['pdfjs-dist','tesseract.js','pdfkit','exceljs','@napi-rs/canvas'] };
export default nextConfig;
