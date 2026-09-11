export type MatchCategory='EXACT_DUPLICATE'|'NEAR_DUPLICATE'|'SAME_STRUCTURE_DIFFERENT_VALUES'|'SAME_CONCEPT_SIMILAR'|'RELATED_BUT_DIFFERENT'|'NOT_SIMILAR';
export interface NumericFeatures{numbers:number[];percentages:number[];ratios:string[];units:string[];variables:string[];equations:string[];operators:string[]}
export interface ParsedQuestion{documentId:string;pdfName:string;pdfUrl:string;questionNumber:string;pageNumber:number;rawQuestionText:string;questionText:string;options:string[];answer?:string;section?:string;subject?:string;questionType?:string;numericFeatures:NumericFeatures}
export interface SimilarityScores{lexical:number;semantic:number;numeric:number;structure:number;final:number}
export interface SimilarityDecision{category:MatchCategory;confidence:number;reason:string;verifiedByLlm:boolean}
