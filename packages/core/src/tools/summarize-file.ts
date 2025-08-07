/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { BaseTool, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import {
  isWithinRoot,
  processSingleFileContent,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import { Config } from '../config/config.js';
import {
  recordFileOperationMetric,
  FileOperation,
} from '../telemetry/metrics.js';

/**
 * Parameters for the SummarizeFile tool
 */
export interface SummarizeFileToolParams {
  /**
   * The absolute path to the file to summarize
   */
  absolute_path: string;
}

/**
 * Implementation of the SummarizeFile tool logic
 */
export class SummarizeFileTool extends BaseTool<SummarizeFileToolParams, ToolResult> {
  static readonly Name: string = 'summarize_file';

  constructor(private config: Config) {
    super(
      SummarizeFileTool.Name,
      'SummarizeFile',
      'Summarizes the content of a specified file from the local filesystem.',
      {
        properties: {
          absolute_path: {
            description:
              "The absolute path to the file to summarize (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: Type.STRING,
          },
        },
        required: ['absolute_path'],
        type: Type.OBJECT,
      },
    );
  }

  validateToolParams(params: SummarizeFileToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}. You must provide an absolute path.`;
    }
    if (!isWithinRoot(filePath, this.config.getTargetDir())) {
      return `File path must be within the root directory (${this.config.getTargetDir()}): ${filePath}`;
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s).`;
    }

    return null;
  }

  getDescription(params: SummarizeFileToolParams): string {
    if (
      !params ||
      typeof params.absolute_path !== 'string' ||
      params.absolute_path.trim() === ''
    ) {
      return `Path unavailable`;
    }
    const relativePath = makeRelative(
      params.absolute_path,
      this.config.getTargetDir(),
    );
    return shortenPath(relativePath);
  }

  async execute(
    params: SummarizeFileToolParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    const result = await processSingleFileContent(
      params.absolute_path,
      this.config.getTargetDir(),
    );

    if (result.error) {
      return {
        llmContent: result.error, // The detailed error for LLM
        returnDisplay: result.returnDisplay, // User-friendly error
      };
    }

    // Handle non-text files or unexpected result structure
    if (!('llmContent' in result) || typeof result.llmContent !== 'string') {
        return {
            llmContent: 'Cannot summarize non-text files.',
            returnDisplay: 'Cannot summarize non-text files.',
        }
    }

    const contentGenerator = this.config.getContentGenerator();
    if (!contentGenerator) {
        const errorMsg = 'Content generator is not available. This may be due to a misconfiguration, missing dependencies, or a failed initialization. Please check your configuration settings and ensure all required dependencies are installed and properly set up.';
        return {
            llmContent: errorMsg,
            returnDisplay: errorMsg,
        }
    }

    const summary = await contentGenerator.generateContent([
        {role: 'user', parts: [{text: `Please summarize the following file content:\n\n${result.llmContent}`}]}
    ]);

    const mimetype = getSpecificMimeType(params.absolute_path);
    recordFileOperationMetric(
      this.config,
      FileOperation.READ,
      undefined,
      mimetype,
      path.extname(params.absolute_path),
    );

    return {
      llmContent: summary.text(),
      returnDisplay: `Successfully summarized file.`,
    };
  }
}
