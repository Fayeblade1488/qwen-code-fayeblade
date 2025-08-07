/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { BaseTool, Icon, ToolLocation, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import {
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

  /**
   * Whether to extract only relevant snippets instead of full content
   */
  snippets?: boolean;

  /**
   * Whether to return only the filename without content
   */
  name_only?: boolean;
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
      'Provides a summary or extracts relevant snippets from a specified file. Can return just the filename, key snippets, or full content summary.',
      Icon.FileSearch,
      {
        properties: {
          absolute_path: {
            description:
              "The absolute path to the file to summarize (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: Type.STRING,
          },
          snippets: {
            description:
              'Optional: If true, extracts only relevant code snippets or key sections instead of full content. Useful for large files.',
            type: Type.BOOLEAN,
          },
          name_only: {
            description:
              'Optional: If true, returns only the filename and basic file info without reading content. Useful for quick file identification.',
            type: Type.BOOLEAN,
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

    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(filePath)) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')}`;
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

  toolLocations(params: SummarizeFileToolParams): ToolLocation[] {
    return [{ path: params.absolute_path }];
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

    // If name_only is true, just return file info without reading content
    if (params.name_only) {
      const relativePath = makeRelative(
        params.absolute_path,
        this.config.getTargetDir(),
      );
      const fileName = path.basename(params.absolute_path);
      const fileExtension = path.extname(params.absolute_path);
      
      return {
        llmContent: `File: ${relativePath}\nName: ${fileName}\nExtension: ${fileExtension}`,
        returnDisplay: `File info: ${fileName}`,
      };
    }

    const result = await processSingleFileContent(
      params.absolute_path,
      this.config.getTargetDir(),
      undefined, // offset
      undefined, // limit
      params.snippets, // extractSnippets flag
    );

    if (result.error) {
      return {
        llmContent: result.error,
        returnDisplay: result.returnDisplay || 'Error reading file',
      };
    }

    const lines =
      typeof result.llmContent === 'string'
        ? result.llmContent.split('\n').length
        : undefined;
    const mimetype = getSpecificMimeType(params.absolute_path);
    recordFileOperationMetric(
      this.config,
      FileOperation.READ,
      lines,
      mimetype,
      path.extname(params.absolute_path),
    );

    // Add summarization context for snippets mode
    let llmContent = result.llmContent;
    if (params.snippets && typeof llmContent === 'string') {
      const relativePath = makeRelative(
        params.absolute_path,
        this.config.getTargetDir(),
      );
      llmContent = `[Relevant snippets from ${relativePath}]\n\n${llmContent}`;
    }

    return {
      llmContent: llmContent || '',
      returnDisplay: result.returnDisplay || '',
    };
  }
}