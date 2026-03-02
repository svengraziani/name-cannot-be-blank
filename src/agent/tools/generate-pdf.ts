/**
 * PDF Generation Tool - Creates PDF documents using PDFKit.
 *
 * Supports titles, paragraphs, tables, and lists.
 * Returns the PDF as a file attachment that gets sent through the channel.
 */

import PDFDocument from 'pdfkit';
import { AgentTool, ToolResult } from './types';

interface PdfSection {
  type: 'title' | 'subtitle' | 'paragraph' | 'table' | 'list' | 'spacing';
  text?: string;
  items?: string[];
  headers?: string[];
  rows?: string[][];
  height?: number;
}

export const generatePdfTool: AgentTool = {
  name: 'generate_pdf',
  description: `Generate a PDF document from structured content. Supports titles, subtitles, paragraphs, tables, lists, and spacing. The generated PDF is sent as a file attachment through the messaging channel.

Example input:
{
  "title": "Order Summary",
  "sections": [
    { "type": "title", "text": "Order Summary" },
    { "type": "paragraph", "text": "Order #12345 – placed on 2025-01-15" },
    { "type": "table", "headers": ["Item", "Qty", "Price"], "rows": [["Widget A", "2", "€19.99"], ["Widget B", "1", "€29.99"]] },
    { "type": "paragraph", "text": "Total: €69.97" }
  ]
}`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['title', 'subtitle', 'paragraph', 'table', 'list', 'spacing'],
              description: 'Section type',
            },
            text: { type: 'string', description: 'Text content (for title, subtitle, paragraph)' },
            items: {
              type: 'array',
              items: { type: 'string' },
              description: 'List items (for list type)',
            },
            headers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Table column headers (for table type)',
            },
            rows: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
              description: 'Table rows as arrays of cell strings (for table type)',
            },
            height: { type: 'number', description: 'Spacing height in points (for spacing type, default: 20)' },
          },
          required: ['type'],
        },
        description: 'Content sections to render in the PDF',
      },
      filename: {
        type: 'string',
        description: 'Output filename (default: document.pdf)',
      },
      pageSize: {
        type: 'string',
        enum: ['A4', 'Letter', 'A3'],
        description: 'Page size (default: A4)',
      },
    },
    required: ['sections'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const sections = input.sections as PdfSection[];
    const filename = (input.filename as string) || 'document.pdf';
    const pageSize = (input.pageSize as string) || 'A4';

    try {
      const doc = new PDFDocument({
        size: pageSize as 'A4' | 'LETTER' | 'A3',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));

      const pageWidth = doc.page.width - 100; // accounting for margins

      for (const section of sections) {
        switch (section.type) {
          case 'title':
            doc
              .fontSize(22)
              .font('Helvetica-Bold')
              .text(section.text || '', { align: 'left' });
            doc.moveDown(0.5);
            // Draw a line under the title
            doc
              .moveTo(50, doc.y)
              .lineTo(50 + pageWidth, doc.y)
              .strokeColor('#333333')
              .lineWidth(1)
              .stroke();
            doc.moveDown(0.8);
            break;

          case 'subtitle':
            doc
              .fontSize(16)
              .font('Helvetica-Bold')
              .text(section.text || '', { align: 'left' });
            doc.moveDown(0.5);
            break;

          case 'paragraph':
            doc
              .fontSize(11)
              .font('Helvetica')
              .text(section.text || '', {
                align: 'left',
                lineGap: 3,
              });
            doc.moveDown(0.5);
            break;

          case 'list':
            if (section.items) {
              doc.fontSize(11).font('Helvetica');
              for (const item of section.items) {
                doc.text(`  •  ${item}`, { indent: 10, lineGap: 2 });
              }
              doc.moveDown(0.5);
            }
            break;

          case 'table':
            if (section.headers && section.rows) {
              const colCount = section.headers.length;
              const colWidth = pageWidth / colCount;
              const startX = 50;
              let y = doc.y;

              // Draw header row
              doc.fontSize(10).font('Helvetica-Bold');
              doc.rect(startX, y, pageWidth, 22).fill('#f0f0f0').stroke('#cccccc');
              for (let i = 0; i < colCount; i++) {
                doc.fillColor('#333333').text(section.headers[i] || '', startX + i * colWidth + 5, y + 6, {
                  width: colWidth - 10,
                  align: 'left',
                });
              }
              y += 22;

              // Draw data rows
              doc.font('Helvetica').fontSize(10);
              for (const row of section.rows) {
                // Check if we need a new page
                if (y + 20 > doc.page.height - 50) {
                  doc.addPage();
                  y = 50;
                }

                const isEven = section.rows.indexOf(row) % 2 === 0;
                if (isEven) {
                  doc.rect(startX, y, pageWidth, 20).fill('#fafafa');
                }
                doc.rect(startX, y, pageWidth, 20).stroke('#e0e0e0');

                for (let i = 0; i < colCount; i++) {
                  doc.fillColor('#333333').text(row[i] || '', startX + i * colWidth + 5, y + 5, {
                    width: colWidth - 10,
                    align: 'left',
                  });
                }
                y += 20;
              }

              doc.y = y;
              doc.moveDown(0.8);
            }
            break;

          case 'spacing':
            doc.moveDown((section.height || 20) / 12);
            break;
        }
      }

      // Finalize
      doc.end();

      // Wait for the stream to finish
      const data = await new Promise<Buffer>((resolve) => {
        doc.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });

      const sectionSummary = sections.map((s) => s.type).join(', ');
      return {
        content: `PDF generated: ${filename} (${Math.round(data.length / 1024)}KB, sections: ${sectionSummary})`,
        files: [
          {
            filename,
            mimeType: 'application/pdf',
            data,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Failed to generate PDF: ${msg}`, isError: true };
    }
  },
};
