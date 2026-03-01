/**
 * Excel Generation Tool - Creates XLSX spreadsheets using ExcelJS.
 *
 * Supports multiple sheets with headers, data rows, column widths, and basic styling.
 * Returns the Excel file as an attachment that gets sent through the channel.
 */

import ExcelJS from 'exceljs';
import { AgentTool, ToolResult } from './types';

interface SheetDefinition {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
  columnWidths?: number[];
}

export const generateExcelTool: AgentTool = {
  name: 'generate_excel',
  description: `Generate an Excel (.xlsx) spreadsheet file. Supports multiple sheets with headers, data rows, column widths, and automatic styling. The generated file is sent as an attachment through the messaging channel.

Example input:
{
  "sheets": [
    {
      "name": "Orders",
      "headers": ["Order ID", "Customer", "Amount", "Status"],
      "rows": [
        ["#1001", "Alice", 149.99, "Shipped"],
        ["#1002", "Bob", 89.50, "Processing"],
        ["#1003", "Charlie", 210.00, "Delivered"]
      ]
    }
  ]
}`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Sheet/tab name' },
            headers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Column headers',
            },
            rows: {
              type: 'array',
              items: {
                type: 'array',
                items: {},
                description: 'Cell values (string, number, boolean, or null)',
              },
              description: 'Data rows',
            },
            columnWidths: {
              type: 'array',
              items: { type: 'number' },
              description: 'Optional column widths (default: auto-sized based on content)',
            },
          },
          required: ['name', 'headers', 'rows'],
        },
        description: 'One or more sheets to include in the workbook',
      },
      filename: {
        type: 'string',
        description: 'Output filename (default: export.xlsx)',
      },
    },
    required: ['sheets'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const sheets = input.sheets as SheetDefinition[];
    const filename = (input.filename as string) || 'export.xlsx';

    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Loop Gateway';
      workbook.created = new Date();

      let totalRows = 0;

      for (const sheetDef of sheets) {
        const worksheet = workbook.addWorksheet(sheetDef.name);

        // Set columns
        worksheet.columns = sheetDef.headers.map((header, i) => {
          const width = sheetDef.columnWidths?.[i] || Math.max(header.length + 4, 12);
          return { header, key: `col_${i}`, width };
        });

        // Style header row
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF4472C4' },
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.height = 24;

        // Add data rows
        for (const row of sheetDef.rows) {
          const dataRow: Record<string, string | number | boolean | null> = {};
          row.forEach((cell, i) => {
            dataRow[`col_${i}`] = cell;
          });
          const addedRow = worksheet.addRow(dataRow);

          // Alternate row background
          if (sheetDef.rows.indexOf(row) % 2 === 0) {
            addedRow.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF2F7FB' },
            };
          }
        }

        // Add borders to all cells
        worksheet.eachRow((row) => {
          row.eachCell((cell) => {
            cell.border = {
              top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
            };
          });
        });

        // Auto-filter on header row
        if (sheetDef.rows.length > 0) {
          worksheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: sheetDef.headers.length },
          };
        }

        totalRows += sheetDef.rows.length;
      }

      // Write to buffer
      const arrayBuffer = await workbook.xlsx.writeBuffer();
      const buffer = Buffer.from(arrayBuffer);

      return {
        content: `Excel file generated: ${filename} (${Math.round(buffer.length / 1024)}KB, ${sheets.length} sheet(s), ${totalRows} row(s))`,
        files: [
          {
            filename,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            data: buffer,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Failed to generate Excel file: ${msg}`, isError: true };
    }
  },
};
