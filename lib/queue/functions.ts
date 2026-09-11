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

type QuestionRecord = {
  id: string;
  document_id: string;
  question_number: string | number | null;
  page_number: number | null;
  raw_text: string;
  normalized_text: string;
  options_json: unknown;
  answer?: unknown;
  section?: string | null;
  subject: string | null;
  question_type: string | null;
  numeric_features?: {
    numbers?: number[];
    percentages?: number[];
    ratios?: string[];
    units?: string[];
    variables?: string[];
    equations?: string[];
    operators?: string[];
  };
  documents?: {
    filename?: string | null;
    source_url?: string | null;
  } | null;
};

type SimilarityQuestion = {
  documentId: string;
  pdfName: string;
  pdfUrl: string;
  questionNumber: string | null;
  pageNumber: number | null;
  rawQuestionText: string;
  questionText: string;
  options: unknown;
  answer?: unknown;
  section?: string | null;
  subject: string | null;
  questionType: string | null;
  numericFeatures: {
    numbers: number[];
    percentages: number[];
    ratios: string[];
    units: string[];
    variables: string[];
    equations: string[];
    operators: string[];
  };
};

type ProcessedDocument = {
  reused: boolean;
  contentHash: string;
  filename: string;
  pageCount: number;
  questionCount: number;
  storagePath: string;
  questions: ReturnType<typeof parseQuestions>;
};

const EMPTY_NUMERIC_FEATURES: SimilarityQuestion['numericFeatures'] = {
  numbers: [],
  percentages: [],
  ratios: [],
  units: [],
  variables: [],
  equations: [],
  operators: [],
};

const CONFLICT_CATEGORIES = new Set([
  'EXACT_DUPLICATE',
  'NEAR_DUPLICATE',
  'SAME_STRUCTURE_DIFFERENT_VALUES',
]);

function toQuestionNumber(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

function normalizeNumericFeatures(
  value: QuestionRecord['numeric_features'],
): SimilarityQuestion['numericFeatures'] {
  return {
    numbers: Array.isArray(value?.numbers)
      ? value.numbers
      : [],
    percentages: Array.isArray(value?.percentages)
      ? value.percentages
      : [],
    ratios: Array.isArray(value?.ratios)
      ? value.ratios
      : [],
    units: Array.isArray(value?.units)
      ? value.units
      : [],
    variables: Array.isArray(value?.variables)
      ? value.variables
      : [],
    equations: Array.isArray(value?.equations)
      ? value.equations
      : [],
    operators: Array.isArray(value?.operators)
      ? value.operators
      : [],
  };
}

function toSimilarityQuestion(
  question: QuestionRecord,
): SimilarityQuestion {
  return {
    documentId: question.document_id,
    pdfName:
      question.documents?.filename ?? 'PDF',
    pdfUrl:
      question.documents?.source_url ?? '',
    questionNumber: toQuestionNumber(
      question.question_number,
    ),
    pageNumber: question.page_number,
    rawQuestionText: question.raw_text,
    questionText: question.normalized_text,
    options: question.options_json ?? [],
    answer: question.answer,
    section: question.section ?? null,
    subject: question.subject,
    questionType: question.question_type,
    numericFeatures: {
      ...EMPTY_NUMERIC_FEATURES,
      ...normalizeNumericFeatures(
        question.numeric_features,
      ),
    },
  };
}

export const discoverDocuments = inngest.createFunction(
  {
    id: 'discover-documents',
    retries: 2,
  },
  {
    event: 'scan/discover.requested',
  },
  async ({ event, step }) => {
    const {
      scanId,
      sheetUrl,
      userId,
      accessToken,
    } = event.data as SheetEventData;

    const links = await step.run(
      'read-sheet',
      () =>
        readPdfLinksFromSheet(
          sheetUrl,
          accessToken,
        ),
    );

    const docs: DocumentRecord[] = [];

    for (const link of links) {
      const document = await step.run(
        `doc-${link.row}-${Buffer.from(
          link.url,
        )
          .toString('base64url')
          .slice(0, 12)}`,
        () =>
          createOrGetDocument(userId, {
            url: link.url,
          }),
      );

      docs.push(document);
    }

    await step.run(
      'attach',
      () =>
        addScanDocuments(
          scanId,
          docs.map((doc) => ({
            id: doc.id,
          })),
        ),
    );

    for (const doc of docs) {
      await inngest.send({
        name: 'document/process.requested',
        data: {
          scanId,
          documentId: doc.id,
          sourceUrl: doc.source_url,
          accessToken,
        },
      });
    }

    return {
      found: docs.length,
    };
  },
);

export const processDocument = inngest.createFunction(
  {
    id: 'process-document',
    retries: 2,
    concurrency: {
      limit: 8,
    },
  },
  {
    event: 'document/process.requested',
  },
  async ({ event, step }) => {
    const {
      scanId,
      documentId,
      sourceUrl,
      accessToken,
    } = event.data as DocumentEventData;

    const db = getSupabaseAdmin();

    await db
      .from('documents')
      .update({
        status: 'processing',
        processing_error: null,
      })
      .eq('id', documentId);

    try {
      const existingResult = await db
        .from('documents')
        .select('*')
        .eq('id', documentId)
        .single();

      if (existingResult.error) {
        throw existingResult.error;
      }

      const existing = existingResult.data;

      const processed =
        await step.run<ProcessedDocument>(
          'download-and-process-pdf',
          async (): Promise<ProcessedDocument> => {
            const downloaded =
              await downloadPdf(
                sourceUrl,
                accessToken,
              );

            if (
              existing?.content_hash ===
                downloaded.contentHash &&
              existing.question_count > 0 &&
              existing.storage_path
            ) {
              const reusedQuestions =
                await db
                  .from('questions')
                  .select('*')
                  .eq(
                    'document_id',
                    documentId,
                  );

              return {
                reused: true,
                contentHash:
                  existing.content_hash,
                filename:
                  existing.filename ?? 'PDF',
                pageCount:
                  existing.page_count ?? 0,
                questionCount:
                  existing.question_count,
                storagePath:
                  existing.storage_path,
                questions:
                  (reusedQuestions.data ??
                    []) as ReturnType<
                    typeof parseQuestions
                  >,
              };
            }

            const storagePath =
              `users/${existing?.user_id}/${downloaded.contentHash}.pdf`;

            await uploadPdf(
              storagePath,
              downloaded.bytes,
            );

            const pages =
              await extractPdfText(
                downloaded.bytes,
              );

            const sparsePages = pages
              .filter(
                (page) =>
                  page.itemCount < 8 ||
                  page.text.length < 80,
              )
              .map(
                (page) =>
                  page.pageNumber,
              );

            const ocr =
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
              pages.map((page) => ({
                pageNumber:
                  page.pageNumber,
                text:
                  page.text.length >= 80
                    ? page.text
                    : (ocr.get(
                        page.pageNumber,
                      ) ?? page.text),
              }));

            const questions =
              parseQuestions(
                documentId,
                downloaded.filename,
                sourceUrl,
                mergedPages,
              );

            return {
              reused: false,
              contentHash:
                downloaded.contentHash,
              filename:
                downloaded.filename,
              pageCount:
                pages.length,
              questionCount:
                questions.length,
              storagePath,
              questions,
            };
          },
        );

      /*
       * For a reused document, the existing questions are
       * already in the database, so do not replace them.
       */
      if (processed.reused) {
        const scan =
          await getScan(scanId);

        await bumpScan(scanId, {
          processed_documents:
            scan.processed_documents + 1,
          total_questions:
            scan.total_questions +
            processed.questionCount,
          current_step:
            `Reused ${processed.filename}`,
        });

        await inngest.send({
          name: 'questions/embed.requested',
          data: {
            scanId,
            documentId,
          },
        });

        return {
          reused: true,
        };
      }

      await replaceQuestions(
        documentId,
        processed.questions,
      );

      await saveDocumentProcessing(
        documentId,
        {
          hash: processed.contentHash,
          size: 0,
          storagePath:
            processed.storagePath,
          pageCount:
            processed.pageCount,
          status: 'processed',
        },
      );

      const scan =
        await getScan(scanId);

      await bumpScan(scanId, {
        processed_documents:
          scan.processed_documents + 1,
        total_questions:
          scan.total_questions +
          processed.questionCount,
        current_step:
          `Processed ${processed.filename}`,
      });

      await inngest.send({
        name: 'questions/embed.requested',
        data: {
          scanId,
          documentId,
        },
      });

      return {
        questions:
          processed.questionCount,
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
        .eq('id', documentId);

      await addError(
        scanId,
        documentId,
        'document_processing',
        message,
      );

      const scan =
        await getScan(scanId);

      await bumpScan(scanId, {
        processed_documents:
          scan.processed_documents + 1,
        errors_count:
          scan.errors_count + 1,
      });

      return {
        failed: true,
        error: message,
      };
    }
  },
);

export const embedQuestions = inngest.createFunction(
  {
    id: 'embed-questions',
    retries: 2,
    concurrency: {
      limit: 3,
    },
  },
  {
    event: 'questions/embed.requested',
  },
  async ({ event, step }) => {
    const {
      scanId,
      documentId,
    } = event.data as EmbedEventData;

    const db =
      getSupabaseAdmin();

    const result = await db
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
        []) as QuestionRecord[];

    if (questions.length === 0) {
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

      const vectors =
        await step.run(
          `embed-${start}`,
          () =>
            provider.embed(
              chunk.map(
                (question) =>
                  question.normalized_text,
              ),
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
      name: 'scan/analyze.requested',
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

export const analyzeScan = inngest.createFunction(
  {
    id: 'analyze-scan',
    retries: 2,
    concurrency: {
      limit: 1,
    },
  },
  {
    event: 'scan/analyze.requested',
  },
  async ({ event }) => {
    const { scanId } =
      event.data as AnalyzeEventData;

    const db =
      getSupabaseAdmin();

    const scanDocumentsResult =
      await db
        .from('scan_documents')
        .select('document_id')
        .eq(
          'scan_id',
          scanId,
        );

    if (
      scanDocumentsResult.error
    ) {
      throw scanDocumentsResult.error;
    }

    const documentIds = (
      scanDocumentsResult.data ??
      []
    ).map(
      (item) =>
        item.document_id,
    );

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

    if (questionsResult.error) {
      throw questionsResult.error;
    }

    const questions =
      (questionsResult.data ??
        []) as QuestionRecord[];

    if (questions.length === 0) {
      await bumpScan(scanId, {
        status:
          'completed',
        completed_at:
          new Date().toISOString(),
        current_step:
          'No questions found',
      });

      return {
        comparisons: 0,
        conflicts: 0,
      };
    }

    let comparisons = 0;
    let conflicts = 0;

    for (const questionA of questions) {
      const candidates =
        await findEmbeddingCandidates(
          scanId,
          questionA.id,
          25,
          0.55,
        );

      for (const candidate of candidates) {
        const questionB =
          questions.find(
            (question) =>
              question.id ===
              candidate.question_id,
          );

        if (
          !questionB ||
          questionA.document_id ===
            questionB.document_id ||
          questionA.id >
            questionB.id
        ) {
          continue;
        }

        const a =
          toSimilarityQuestion(
            questionA,
          );

        const b =
          toSimilarityQuestion(
            questionB,
          );

        const scores =
          scorePair(
            a,
            b,
            Number(candidate.score),
          );

        let decision =
          classify(
            scores,
            a,
            b,
          );

        let verifierPayload:
          unknown = undefined;

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
                a.rawQuestionText,
                b.rawQuestionText,
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
          questionA.id,
          questionB.id,
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

    await bumpScan(scanId, {
      comparisons_generated:
        comparisons,
      conflicts_count:
        conflicts,
      current_step:
        'Similarity analysis complete',
    });

    const scan =
      await getScan(scanId);

    await bumpScan(scanId, {
      status:
        scan.errors_count > 0
          ? 'completed_with_errors'
          : 'completed',
      completed_at:
        new Date().toISOString(),
      current_step:
        'Completed',
    });

    return {
      comparisons,
      conflicts,
    };
  },
);

export const allFunctions = [
  discoverDocuments,
  processDocument,
  embedQuestions,
  analyzeScan,
];
