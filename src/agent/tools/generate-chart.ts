/**
 * Chart Generation Tool - Creates PNG chart images using Chart.js.
 *
 * Supports bar, line, pie, doughnut, radar, and polarArea chart types.
 * Returns the chart as a PNG file attachment that gets sent through the channel.
 */

import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { AgentTool, ToolResult } from './types';

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;

export const generateChartTool: AgentTool = {
  name: 'generate_chart',
  description: `Generate a chart image (PNG) from data using Chart.js. Supports bar, line, pie, doughnut, radar, and polarArea chart types. The generated PNG is sent as a file attachment through the messaging channel.

Example input for a bar chart:
{
  "type": "bar",
  "title": "Revenue Last Week",
  "labels": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  "datasets": [
    { "label": "Revenue (€)", "data": [1200, 1900, 800, 1500, 2000, 1700, 900] }
  ]
}`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea'],
        description: 'The chart type',
      },
      title: {
        type: 'string',
        description: 'Chart title displayed at the top',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for the X axis (or segments for pie/doughnut)',
      },
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Dataset label (legend entry)' },
            data: {
              type: 'array',
              items: { type: 'number' },
              description: 'Numeric data values',
            },
            backgroundColor: {
              description: 'Background color(s) - single string or array of strings',
            },
            borderColor: {
              description: 'Border color(s) - single string or array of strings',
            },
          },
          required: ['label', 'data'],
        },
        description: 'One or more datasets to plot',
      },
      width: {
        type: 'number',
        description: `Image width in pixels (default: ${DEFAULT_WIDTH})`,
      },
      height: {
        type: 'number',
        description: `Image height in pixels (default: ${DEFAULT_HEIGHT})`,
      },
      filename: {
        type: 'string',
        description: 'Output filename (default: chart.png)',
      },
    },
    required: ['type', 'labels', 'datasets'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const chartType = input.type as string;
    const title = (input.title as string) || '';
    const labels = input.labels as string[];
    const datasets = input.datasets as Array<{
      label: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
    }>;
    const width = (input.width as number) || DEFAULT_WIDTH;
    const height = (input.height as number) || DEFAULT_HEIGHT;
    const filename = (input.filename as string) || 'chart.png';

    // Default color palette
    const defaultColors = [
      'rgba(54, 162, 235, 0.7)',
      'rgba(255, 99, 132, 0.7)',
      'rgba(75, 192, 192, 0.7)',
      'rgba(255, 206, 86, 0.7)',
      'rgba(153, 102, 255, 0.7)',
      'rgba(255, 159, 64, 0.7)',
      'rgba(199, 199, 199, 0.7)',
      'rgba(83, 102, 255, 0.7)',
      'rgba(255, 99, 255, 0.7)',
      'rgba(99, 255, 132, 0.7)',
    ];

    const defaultBorderColors = defaultColors.map((c) => c.replace('0.7', '1'));

    const isPieType = chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea';

    const chartDatasets = datasets.map((ds, i) => ({
      label: ds.label,
      data: ds.data,
      backgroundColor:
        ds.backgroundColor ||
        (isPieType ? defaultColors.slice(0, ds.data.length) : defaultColors[i % defaultColors.length]),
      borderColor:
        ds.borderColor ||
        (isPieType
          ? defaultBorderColors.slice(0, ds.data.length)
          : defaultBorderColors[i % defaultBorderColors.length]),
      borderWidth: isPieType ? 2 : 2,
      fill: chartType === 'radar',
    }));

    try {
      const chartCanvas = new ChartJSNodeCanvas({
        width,
        height,
        backgroundColour: 'white',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configuration: any = {
        type: chartType,
        data: {
          labels,
          datasets: chartDatasets,
        },
        options: {
          responsive: false,
          plugins: {
            title: {
              display: !!title,
              text: title,
              font: { size: 18, weight: 'bold' },
              padding: { top: 10, bottom: 20 },
            },
            legend: {
              display: true,
              position: 'bottom' as const,
            },
          },
        },
      };

      // Add scales config for non-pie charts
      if (!isPieType) {
        configuration.options.scales = {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.1)' },
          },
          x: {
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
        };
      }

      const buffer = await chartCanvas.renderToBuffer(configuration);

      return {
        content: `Chart generated: ${title || chartType} (${width}x${height}px, ${labels.length} data points, ${datasets.length} dataset(s))`,
        files: [
          {
            filename,
            mimeType: 'image/png',
            data: buffer,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Failed to generate chart: ${msg}`, isError: true };
    }
  },
};
