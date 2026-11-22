import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { join, documentDir } from '@tauri-apps/api/path';
import { toast } from 'sonner';
import { EngineType } from '../types';

export function useExport() {
  const resolveDefaultExportPath = useCallback(async (projectRoot: string | null, defaultFileName: string): Promise<string> => {
    if (projectRoot) {
      try {
        return await join(projectRoot, defaultFileName);
      } catch {
        const sep = projectRoot.includes('\\') ? '\\' : '/';
        return projectRoot.endsWith(sep)
          ? `${projectRoot}${defaultFileName}`
          : `${projectRoot}${sep}${defaultFileName}`;
      }
    }
    try {
      const docs = await documentDir();
      return await join(docs, defaultFileName);
    } catch {
      return defaultFileName;
    }
  }, []);

  const downloadPdf = useCallback(async (
    pdfBytes: Uint8Array | null,
    projectName: string,
    projectRoot: string | null,
  ) => {
    if (!pdfBytes || pdfBytes.length === 0) {
      toast.error('No compiled PDF available to export');
      return;
    }

    try {
      const defaultName = projectName ? `${projectName}.pdf` : 'document.pdf';
      const initialPath = await resolveDefaultExportPath(projectRoot, defaultName);
      const filePath = await save({
        title: 'Save PDF Document As...',
        defaultPath: initialPath,
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      });

      if (!filePath) return;

      await invoke('save_pdf_to_file', {
        path: filePath,
        bytes: Array.from(pdfBytes),
      });

      toast.success('PDF saved successfully', { description: filePath });
    } catch (err: unknown) {
      console.warn('Native save dialog error, falling back:', err);
      try {
        const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'document.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success('PDF downloaded');
      } catch {
        toast.error('Failed to export PDF');
      }
    }
  }, [resolveDefaultExportPath]);

  const exportZip = useCallback(async (
    projectRoot: string | null,
    projectName: string,
    sourceCode: string,
    engine: EngineType,
  ) => {
    try {
      const defaultName = projectName ? `${projectName}_source.zip` : 'project_source.zip';
      const initialPath = await resolveDefaultExportPath(projectRoot, defaultName);
      const filePath = await save({
        title: 'Export Project as ZIP Archive',
        defaultPath: initialPath,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      });

      if (!filePath) return;

      toast.loading('Packaging project archive...', { id: 'export-zip' });
      await invoke('export_project_to_zip', {
        destPath: filePath,
        projectDir: projectRoot,
        sourceContent: sourceCode,
        engine,
      });

      toast.success('Project archive exported successfully', {
        id: 'export-zip',
        description: filePath,
      });
    } catch (err: unknown) {
      console.error('Failed to export ZIP:', err);
      toast.error('Failed to export ZIP archive', {
        id: 'export-zip',
        description: String(err),
      });
    }
  }, [resolveDefaultExportPath]);

  return {
    downloadPdf,
    exportZip,
  };
}
