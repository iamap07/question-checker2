import { inngest } from './inngest';
import { readPdfLinksFromSheet } from '../google/sheets';

import {
  createOrGetDocument,
  addScanDocuments,
  saveDocumentProcessing,
  replaceQuestions,
  saveEmbedding,
  findEmbeddingCandidates,
  saveMatch,
  bumpScan,
  addError,
  getScan,
} from '../database/repository';

import { downloadPdf } from '../pdf/downloader';
import { extractPdfText } from '../pdf/text';
import { ocrPages } from '../pdf/ocr';
import { parseQuestions } from '../pdf/questions';

import { createEmbeddingProvider } from '../ai/embeddings';

import {
  scorePair,
  classify,
  shouldVerify,
} from '../similarity/engine';

import { verifyWithClaude } from '../ai/claude';

import { getSupabaseAdmin } from '../database/supabase';
import { uploadPdf } from '../storage/supabase-storage';

import type {
  ParsedQuestion,
  SimilarityDecision,
} from '../../types';

type DocumentRecord = Awaited<
  ReturnType<typeof createOrGetDocument>
>;

type SheetEventData = {
  scanId: string;
  sheetUrl: string;
  userId: string;
  accessToken?: string;
};

type DocumentEventData = {
  scanId: string;
  documentId: string;
  sourceUrl: string;
  accessToken?: string;
};

type EmbedEventData = {
  scanId: string;
  documentId: string;
};

type AnalyzeEventData = {
  scanId: string;
};

type QuestionRow = {
  id: string;
  document_id: string;
  question_number: string | number | null;
  page_number: number | null;
  raw_text: string;
  normalized_text: string;
  options_json: string[] | null;
  answer: string | null;
  section: string | null;
  subject: string | null;
  question_type: string | null;
  numeric_features: {
    numbers?: number[];
    percentages?: number[];
    ratios?: string[];
    units?: string[];
    variables?: string[];
    equations?: string[];
    operators?: string[];
  } | null;
  documents?: {
    filename?: string | null;
    source_url?: string | null;
  } | null;
};

const CONFLICT_CATEGORIES = new Set([
  'EXACT_DUPLICATE',
  'NEAR_DUPLICATE',
  'SAME_STRUCTURE_DIFFERENT_VALUES',
]);

function asQuestionNumber(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function asNumber(
  value: number | null | undefined,
): number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value;
  }

  return 0;
}

function toParsedQuestion(
  row: QuestionRow,
): ParsedQuestion {
  const features =
    row.numeric_features ?? {};

  return {
    documentId: row.document_id,

    pdfName:
      row.documents?.filename ?? 'PDF',

    pdfUrl:
      row.documents?.source_url ?? '',

    questionNumber:
      asQuestionNumber(
        row.question_number,
      ),

    pageNumber:
      asNumber(row.page_number),

    rawQuestionText:
      row.raw_text ?? '',

    questionText:
      row.normalized_text ?? '',

    options:
      Array.isArray(
        row.options_json,
      )
        ? row.options_json
        : [],

    answer:
      row.answer ?? undefined,

    section:
      row.section ?? undefined,

    subject:
      row.subject ?? undefined,

    questionType:
      row.question_type ?? undefined,

    numericFeatures: {
      numbers:
        Array.isArray(
          features.numbers,
        )
          ? features.numbers
          : [],

      percentages:
        Array.isArray(
          features.percentages,
        )
          ? features.percentages
          : [],

      ratios:
        Array.isArray(
          features.ratios,
        )
          ? features.ratios
          : [],

      units:
        Array.isArray(
          features.units,
        )
          ? features.units
          : [],

      variables:
        Array.isArray(
          features.variables,
        )
          ? features.variables
          : [],

      equations:
        Array.isArray(
          features.equations,
        )
          ? features.equations
          : [],

      operators:
        Array.isArray(
          features.operators,
        )
          ? features.operators
          : [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                           DISCOVER DOCUMENTS                               */
/* -------------------------------------------------------------------------- */

export const discoverDocuments =
  inngest.createFunction(
    {
      id: 'discover-documents',
      retries: 2,
    },
    {
      event:
        'scan/discover.requested',
    },
    async ({ event, step }) => {
      const {
        scanId,
        sheetUrl,
        userId,
        accessToken,
      } =
        event.data as SheetEventData;

      const links =
        await step.run(
          'read-sheet',
          () =>
            readPdfLinksFromSheet(
              sheetUrl,
              accessToken,
            ),
        );

      /*
       * Explicit type prevents TypeScript
       * from treating docs as any[].
       */
      const docs: DocumentRecord[] = [];

      for (const link of links) {
        const document =
          await step.run(
            `document-${link.row}-${Buffer.from(
              link.url,
            )
              .toString(
                'base64url',
              )
              .slice(0, 12)}`,
            () =>
              createOrGetDocument(
                userId,
                {
                  url: link.url,
                },
              ),
          );

        docs.push(document);
      }

      await step.run(
        'attach-documents',
        () =>
          addScanDocuments(
            scanId,
            docs.map(
              (doc) => ({
                id: doc.id,
              }),
            ),
          ),
      );

      for (const doc of docs) {
        await inngest.send({
          name:
            'document/process.requested',

          data: {
            scanId,
            documentId: doc.id,
            sourceUrl:
              doc.source_url,
            accessToken,
          },
        });
      }

      return {
        found: docs.length,
      };
    },
  );

/* -------------------------------------------------------------------------- */
/*                           PROCESS DOCUMENT                                 */
/* -------------------------------------------------------------------------- */

export const processDocument =
  inngest.createFunction(
    {
      id: 'process-document',
      retries: 2,

      concurrency: {
        limit: 8,
      },
    },
    {
      event:
        'document/process.requested',
    },
    async ({ event, step }) => {
      const {
        scanId,
        documentId,
        sourceUrl,
        accessToken,
      } =
        event.data as DocumentEventData;

      const db =
        getSupabaseAdmin();

      await db
        .from('documents')
        .update({
          status: 'processing',
          processing_error: null,
        })
        .eq(
          'id',
          documentId,
        );

      try {
        /*
         * All Buffer-dependent work remains
         * inside a single Inngest step.
         */
        const result =
          await step.run(
            'download-process-and-save',
            async () => {
              const existingResult =
                await db
                  .from('documents')
                  .select('*')
                  .eq(
                    'id',
                    documentId,
                  )
                  .single();

              if (
                existingResult.error
              ) {
                throw existingResult.error;
              }

              const existing =
                existingResult.data;

              const downloaded =
                await downloadPdf(
                  sourceUrl,
                  accessToken,
                );

              /*
               * Reuse unchanged document.
               */
              if (
                existing?.content_hash ===
                  downloaded.contentHash &&
                Number(
                  existing.question_count ??
                    0,
                ) > 0 &&
                existing.storage_path
              ) {
                return {
                  reused: true,
                  filename:
                    existing.filename ??
                    'PDF',
                  questionCount:
                    Number(
                      existing.question_count ??
                        0,
                    ),
                };
              }

              const storagePath =
                `users/${existing?.user_id ?? 'unknown'}/${downloaded.contentHash}.pdf`;

              await uploadPdf(
                storagePath,
                downloaded.bytes,
              );

              const pages =
                await extractPdfText(
                  downloaded.bytes,
                );

              /*
               * Detect pages requiring OCR.
               */
              const sparsePages =
                pages
                  .filter(
                    (page) =>
                      page.itemCount <
                        8 ||
                      page.text.length <
                        80,
                  )
                  .map(
                    (page) =>
                      page.pageNumber,
                  );

              const ocrResult =
                sparsePages.length > 0
                  ? await ocrPages(
                      downloaded.bytes,
                      sparsePages,
                    )
                  : new Map<
                      number,
                      string
                    >();

              const mergedPages =
                pages.map(
                  (page) => ({
                    pageNumber:
                      page.pageNumber,

                    text:
                      page.text.length >=
                      80
                        ? page.text
                        : (
                            ocrResult.get(
                              page.pageNumber,
                            ) ??
                            page.text
                          ),
                  }),
                );

              /*
               * Parse only the question area.
               */
              const questions =
                parseQuestions(
                  documentId,
                  downloaded.filename,
                  sourceUrl,
                  mergedPages,
                );

              /*
               * Save questions while still
               * inside the step.
               */
              await replaceQuestions(
                documentId,
                questions,
              );

              await saveDocumentProcessing(
                documentId,
                {
                  hash:
                    downloaded.contentHash,

                  size:
                    downloaded.bytes
                      .length,

                  storagePath,

                  pageCount:
                    pages.length,

                  status:
                    'processed',
                },
              );

              return {
                reused: false,

                filename:
                  downloaded.filename,

                questionCount:
                  questions.length,
              };
            },
          );

        const scan =
          await getScan(
            scanId,
          );

        await bumpScan(
          scanId,
          {
            processed_documents:
              scan.processed_documents +
              1,

            total_questions:
              scan.total_questions +
              result.questionCount,

            current_step:
              result.reused
                ? `Reused ${result.filename}`
                : `Processed ${result.filename}`,
          },
        );

        await inngest.send({
          name:
            'questions/embed.requested',

          data: {
            scanId,
            documentId,
          },
        });

        return {
          reused:
            result.reused,

          questions:
            result.questionCount,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        await db
          .from('documents')
          .update({
            status: 'failed',
            processing_error:
              message,
          })
          .eq(
            'id',
            documentId,
          );

        await addError(
          scanId,
          documentId,
          'document_processing',
          message,
        );

        const scan =
          await getScan(
            scanId,
          );

        await bumpScan(
          scanId,
          {
            processed_documents:
              scan.processed_documents +
              1,

            errors_count:
              scan.errors_count +
              1,
          },
        );

        return {
          failed: true,
          error: message,
        };
      }
    },
  );

/* -------------------------------------------------------------------------- */
/*                              EMBEDDINGS                                    */
/* -------------------------------------------------------------------------- */

export const embedQuestions =
  inngest.createFunction(
    {
      id: 'embed-questions',
      retries: 2,

      concurrency: {
        limit: 3,
      },
    },
    {
      event:
        'questions/embed.requested',
    },
    async ({ event, step }) => {
      const {
        scanId,
        documentId,
      } =
        event.data as EmbedEventData;

      const db =
        getSupabaseAdmin();

      const result =
        await db
          .from('questions')
          .select('*')
          .eq(
            'document_id',
            documentId,
          );

      if (result.error) {
        throw result.error;
      }

      const questions =
        (result.data ??
          []) as QuestionRow[];

      if (
        questions.length === 0
      ) {
        await inngest.send({
          name:
            'scan/analyze.requested',

          data: {
            scanId,
          },
        });

        return {
          embedded: 0,
        };
      }

      const provider =
        createEmbeddingProvider();

      for (
        let start = 0;
        start < questions.length;
        start += 50
      ) {
        const chunk =
          questions.slice(
            start,
            start + 50,
          );

        const texts =
          chunk.map(
            (question) =>
              question.normalized_text,
          );

        const vectors =
          await step.run(
            `embed-${start}`,
            () =>
              provider.embed(
                texts,
              ),
          );

        for (
          let index = 0;
          index < chunk.length;
          index++
        ) {
          await saveEmbedding(
            chunk[index].id,
            vectors[index],
            provider.name,
            provider.model,
          );
        }
      }

      await inngest.send({
        name:
          'scan/analyze.requested',

        data: {
          scanId,
        },
      });

      return {
        embedded:
          questions.length,
      };
    },
  );

/* -------------------------------------------------------------------------- */
/*                         ANALYZE SIMILARITY                                 */
/* -------------------------------------------------------------------------- */

export const analyzeScan =
  inngest.createFunction(
    {
      id: 'analyze-scan',
      retries: 2,

      concurrency: {
        limit: 1,
      },
    },
    {
      event:
        'scan/analyze.requested',
    },
    async ({ event }) => {
      const { scanId } =
        event.data as AnalyzeEventData;

      const db =
        getSupabaseAdmin();

      const scanDocumentsResult =
        await db
          .from('scan_documents')
          .select(
            'document_id',
          )
          .eq(
            'scan_id',
            scanId,
          );

      if (
        scanDocumentsResult.error
      ) {
        throw scanDocumentsResult.error;
      }

      const documentIds =
        (
          scanDocumentsResult.data ??
          []
        ).map(
          (item) =>
            item.document_id,
        );

      if (
        documentIds.length === 0
      ) {
        await bumpScan(
          scanId,
          {
            status:
              'completed',

            completed_at:
              new Date().toISOString(),

            current_step:
              'No documents found',
          },
        );

        return {
          comparisons: 0,
          conflicts: 0,
        };
      }

      const questionsResult =
        await db
          .from('questions')
          .select(
            '*,documents!inner(filename,source_url)',
          )
          .in(
            'document_id',
            documentIds,
          );

      if (
        questionsResult.error
      ) {
        throw questionsResult.error;
      }

      const questions =
        (questionsResult.data ??
          []) as QuestionRow[];

      if (
        questions.length === 0
      ) {
        await bumpScan(
          scanId,
          {
            status:
              'completed',

            completed_at:
              new Date().toISOString(),

            current_step:
              'No questions found',
          },
        );

        return {
          comparisons: 0,
          conflicts: 0,
        };
      }

      let comparisons = 0;
      let conflicts = 0;

      for (
        const rowA of questions
      ) {
        const candidates =
          await findEmbeddingCandidates(
            scanId,
            rowA.id,
            25,
            0.55,
          );

        for (
          const candidate of candidates
        ) {
          const rowB =
            questions.find(
              (question) =>
                question.id ===
                candidate.question_id,
            );

          if (!rowB) {
            continue;
          }

          /*
           * Never compare questions
           * from the same PDF.
           */
          if (
            rowA.document_id ===
            rowB.document_id
          ) {
            continue;
          }

          /*
           * Canonical pair ordering.
           */
          if (
            rowA.id >
            rowB.id
          ) {
            continue;
          }

          const questionA =
            toParsedQuestion(
              rowA,
            );

          const questionB =
            toParsedQuestion(
              rowB,
            );

          const scores =
            scorePair(
              questionA,
              questionB,
              Number(
                candidate.score,
              ),
            );

          let decision:
            SimilarityDecision =
            classify(
              scores,
              questionA,
              questionB,
            );

          let verifierPayload:
            unknown = undefined;

          /*
           * Use Claude only for
           * uncertain/high-value pairs.
           */
          if (
            shouldVerify(
              scores,
            ) &&
            process.env
              .ANTHROPIC_API_KEY
          ) {
            try {
              const verification =
                await verifyWithClaude(
                  questionA.rawQuestionText,
                  questionB.rawQuestionText,
                  scores,
                );

              decision = {
                ...verification,
                verifiedByLlm:
                  true,
              };

              verifierPayload =
                verification.payload;
            } catch (error) {
              await addError(
                scanId,
                null,
                'ai_verification',
                error instanceof Error
                  ? error.message
                  : String(error),
              );
            }
          }

          await saveMatch(
            scanId,
            rowA.id,
            rowB.id,
            scores,
            decision,
            verifierPayload,
          );

          comparisons += 1;

          if (
            CONFLICT_CATEGORIES.has(
              decision.category,
            )
          ) {
            conflicts += 1;
          }
        }
      }

      await bumpScan(
        scanId,
        {
          comparisons_generated:
            comparisons,

          conflicts_count:
            conflicts,

          current_step:
            'Similarity analysis complete',
        },
      );

      const scan =
        await getScan(
          scanId,
        );

      await bumpScan(
        scanId,
        {
          status:
            scan.errors_count > 0
              ? 'completed_with_errors'
              : 'completed',

          completed_at:
            new Date().toISOString(),

          current_step:
            'Completed',
        },
      );

      return {
        comparisons,
        conflicts,
      };
    },
  );

/* -------------------------------------------------------------------------- */
/*                               ALL FUNCTIONS                                */
/* -------------------------------------------------------------------------- */

export const allFunctions = [
  discoverDocuments,
  processDocument,
  embedQuestions,
  analyzeScan,
];
