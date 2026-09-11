# Question Paper Similarity Checker

Production-oriented Next.js/TypeScript application that reads PDF links from Google Sheets, downloads PDFs from direct URLs or Google Drive, extracts questions with OCR fallback, compares them with lexical + embedding + numerical + structure signals, verifies borderline matches with Claude, and exports reports.

## Stack
Next.js + TypeScript + Tailwind; Google OAuth / Sheets / Drive; Supabase Postgres + Storage + pgvector; Inngest background functions; PDF.js + Tesseract OCR; OpenAI-compatible embeddings; Anthropic Claude verification; CSV/XLSX/JSON/PDF exports.

## Setup
1. Copy `.env.example` to `.env.local`.
2. Run `database/schema.sql` in Supabase. Create a private `question-papers` storage bucket.
3. Enable Google Sheets + Drive APIs in Google Cloud and configure OAuth. Add redirect URI `http://localhost:3000/api/auth/callback/google` (or your deployed URL).
4. Add `GOOGLE_API_KEY` for public Sheets mode. Private Sheets/Drive use Google OAuth.
5. Configure Anthropic and an OpenAI-compatible embedding endpoint.
6. Configure Inngest with `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, and `APP_URL`; handler URL is `/api/inngest`.
7. Install dependencies with `npm install`, then `npm run dev`.

## Security
API keys are server-side. PDF URLs are validated and private-network targets rejected. Anonymous public scans receive a high-entropy access token whose SHA-256 hash is stored; authenticated scans use the Google account. PDFs are stored in private Supabase Storage.

## Test / deploy
`npm run typecheck`, `npm test`, and `npm run build` are the intended checks. Vercel hosts the web app; Inngest runs the async document/embedding/similarity functions.

The scan flow is: sheet discovery → document dedupe → PDF download/cache by SHA-256 → text extraction → OCR fallback → question parsing → embeddings → candidate retrieval → hybrid scoring → optional Claude verification → report.
