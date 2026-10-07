export { classifyLatexContext, classifyLatexRange, symbolInsertion } from './context';
export { generateMatrix, generateTable, validateGroups, WritingGenerationError } from './generate';
export { parseWritingStructureAt } from './parser';
export { inspectPackageEligibility, inspectPackageLoadState, planPackageAddition, requiredPackagesInSource } from './packages';
export { searchWritingSymbols, WRITING_CATEGORIES, WRITING_SYMBOLS } from './symbols';
export type {
  MathContext,
  MatrixOptions,
  PackageEditPlan,
  ParsedStructure,
  SymbolEntry,
  TableOptions,
  WritingCategory,
} from '../../types/writing';
