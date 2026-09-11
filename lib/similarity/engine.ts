import type {
  ParsedQuestion,
  SimilarityDecision,
  SimilarityScores,
} from '../../types';

import {
  jaccardTokens,
  numericSimilarity,
} from './math';

export function scorePair(
  a: ParsedQuestion,
  b: ParsedQuestion,
  semantic: number,
): SimilarityScores {
  const lexical = jaccardTokens(
    a.questionText,
    b.questionText,
  );

  const numeric = numericSimilarity(
    a.numericFeatures,
    b.numericFeatures,
  );

  const sameSubject =
    a.subject !== undefined &&
    a.subject !== null &&
    a.subject === b.subject;

  const sameQuestionType =
    a.questionType !== undefined &&
    a.questionType !== null &&
    a.questionType === b.questionType;

  const sameOperators =
    a.numericFeatures.operators.join('') ===
    b.numericFeatures.operators.join('');

  const sameOptionCount =
    a.options.length === b.options.length;

  const structure =
    (sameSubject ? 0.4 : 0) +
    (sameQuestionType ? 0.3 : 0) +
    (sameOperators ? 0.15 : 0) +
    (sameOptionCount ? 0.15 : 0);

  const finalScore = Math.max(
    0,
    Math.min(
      1,
      lexical * 0.2 +
        semantic * 0.5 +
        numeric * 0.2 +
        structure * 0.1,
    ),
  );

  return {
    lexical,
    semantic,
    numeric,
    structure,
    final: finalScore,
  };
}

export function classify(
  scores: SimilarityScores,
  a: ParsedQuestion,
  b: ParsedQuestion,
): SimilarityDecision {
  const sameText =
    a.questionText === b.questionText;

  const sameNumbers =
    JSON.stringify(
      a.numericFeatures.numbers,
    ) ===
    JSON.stringify(
      b.numericFeatures.numbers,
    );

  const samePercentages =
    JSON.stringify(
      a.numericFeatures.percentages,
    ) ===
    JSON.stringify(
      b.numericFeatures.percentages,
    );

  const sameRatios =
    JSON.stringify(
      a.numericFeatures.ratios,
    ) ===
    JSON.stringify(
      b.numericFeatures.ratios,
    );

  const sameNumericData =
    sameNumbers &&
    samePercentages &&
    sameRatios;

  if (
    sameText &&
    sameNumericData
  ) {
    return {
      category:
        'EXACT_DUPLICATE',
      confidence: 0.995,
      reason:
        'Normalized question text and numerical data are effectively identical.',
      verifiedByLlm: false,
    };
  }

  if (
    scores.final >= 0.9 &&
    sameNumericData
  ) {
    return {
      category:
        'NEAR_DUPLICATE',
      confidence: Math.min(
        0.99,
        scores.final,
      ),
      reason:
        'The questions are nearly identical and preserve the same numerical conditions.',
      verifiedByLlm: false,
    };
  }

  if (
    scores.semantic >= 0.84 &&
    scores.structure >= 0.72 &&
    scores.numeric >= 0.4 &&
    !sameNumericData
  ) {
    return {
      category:
        'SAME_STRUCTURE_DIFFERENT_VALUES',
      confidence: Math.min(
        0.96,
        scores.final + 0.04,
      ),
      reason:
        'The questions share the same underlying problem structure while important input values differ.',
      verifiedByLlm: false,
    };
  }

  if (
    scores.semantic >= 0.82 &&
    scores.structure >= 0.65
  ) {
    return {
      category:
        'SAME_CONCEPT_SIMILAR',
      confidence: Math.min(
        0.95,
        scores.final,
      ),
      reason:
        'The questions use a closely related concept and solving approach but are not sufficiently close to be duplicates.',
      verifiedByLlm: false,
    };
  }

  if (
    scores.semantic >= 0.68
  ) {
    return {
      category:
        'RELATED_BUT_DIFFERENT',
      confidence:
        scores.final,
      reason:
        'The questions share topical language but differ materially in problem structure or constraints.',
      verifiedByLlm: false,
    };
  }

  return {
    category:
      'NOT_SIMILAR',
    confidence:
      1 - scores.final,
    reason:
      'Insufficient evidence of the same question structure or meaning.',
    verifiedByLlm: false,
  };
}

export function shouldVerify(
  scores: SimilarityScores,
): boolean {
  return (
    (scores.final >= 0.72 &&
      scores.final < 0.9) ||
    (scores.semantic >= 0.82 &&
      scores.numeric < 0.55)
  );
}

export function canonicalPair(
  a: string,
  b: string,
): [string, string] {
  return a < b
    ? [a, b]
    : [b, a];
}
