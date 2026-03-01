/**
 * Template Gallery - Pre-built Agent Group templates for one-click import.
 *
 * Each template includes a pre-configured system prompt, skills, approval rules,
 * and optional scheduler jobs to get users started quickly.
 */

import type { CreateAgentGroupInput } from './types';
import type { ApprovalRule } from '../hitl/types';

export interface SchedulerJobTemplate {
  name: string;
  description: string;
  trigger: {
    type: 'daily' | 'weekly' | 'interval';
    time?: { hour: number; minute: number };
    days?: number[];
    timezone: string;
    intervalMinutes?: number;
  };
  action: {
    prompt: string;
    contextTemplate?: string;
    maxIterations: number;
  };
  output: {
    type: 'channel' | 'webhook' | 'file' | 'email';
  };
}

export interface AgentGroupTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  group: Omit<CreateAgentGroupInput, 'apiKey' | 'githubToken'>;
  approvalRules: Array<Omit<ApprovalRule, 'id'>>;
  schedulerJobs: SchedulerJobTemplate[];
}

export const TEMPLATES: AgentGroupTemplate[] = [
  // ─────────────────────────── Customer Support Bot ───────────────────────────
  {
    id: 'customer-support-bot',
    name: 'Customer Support Bot',
    description:
      'Freundlicher Support-Agent mit Ticket-Tracking, FAQ-Antworten und Eskalationslogik. Ideal fuer Telegram oder WhatsApp Kanaele.',
    category: 'Support',
    icon: '&#9993;',
    color: '#60a5fa',
    group: {
      name: 'Customer Support Bot',
      description: 'Pre-configured customer support agent with FAQ handling and escalation logic.',
      systemPrompt: `You are a friendly and professional customer support agent for our company.

## Your Core Responsibilities
- Answer customer questions accurately and helpfully
- Track and reference ongoing support issues
- Escalate complex problems to human agents when needed
- Maintain a warm, professional tone at all times

## Communication Guidelines
- Always greet customers warmly
- Acknowledge the customer's issue before providing solutions
- Use simple, clear language (avoid technical jargon unless the customer uses it)
- If you don't know the answer, say so honestly and offer to escalate
- End conversations by asking if there's anything else you can help with

## Escalation Rules
- Escalate immediately if the customer mentions: billing disputes, account security, legal issues, or data deletion
- Escalate if you cannot resolve the issue after 2 attempts
- When escalating, summarize the issue clearly for the human agent

## Response Format
- Keep responses concise (2-4 sentences for simple questions)
- Use numbered steps for instructions
- Provide links or references when available

## Tools Usage
- Use web_browse to look up product information or documentation
- Use http_request to check service status or APIs
- Never execute scripts or modify any systems directly`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      skills: ['web_browse', 'http_request'],
      roles: [],
      containerMode: false,
      maxConcurrentAgents: 5,
      budgetMaxTokensDay: 500000,
      budgetMaxTokensMonth: 10000000,
      budgetAlertThreshold: 80,
    },
    approvalRules: [
      {
        toolName: 'http_request',
        riskLevel: 'medium',
        autoApprove: false,
        requireApproval: false,
        timeoutSeconds: 0,
        timeoutAction: 'reject',
        enabled: true,
      },
      {
        toolName: 'run_script',
        riskLevel: 'critical',
        autoApprove: false,
        requireApproval: true,
        timeoutSeconds: 600,
        timeoutAction: 'reject',
        enabled: true,
      },
    ],
    schedulerJobs: [],
  },

  // ─────────────────────────── Order Tracking Agent ───────────────────────────
  {
    id: 'order-tracking-agent',
    name: 'Order Tracking Agent',
    description:
      'Verfolgt Bestellungen, prueft Lieferstatus und informiert Kunden proaktiv ueber Aenderungen. Mit HTTP-API-Zugang und geplanten Status-Checks.',
    category: 'E-Commerce',
    icon: '&#128230;',
    color: '#4ade80',
    group: {
      name: 'Order Tracking Agent',
      description: 'Tracks orders, checks delivery status, and proactively notifies customers about changes.',
      systemPrompt: `You are an order tracking and logistics agent.

## Your Core Responsibilities
- Look up order status when customers provide order numbers or tracking IDs
- Provide estimated delivery dates and shipping updates
- Help customers with order modifications (if still possible)
- Proactively inform about delays or issues

## Order Lookup Process
1. Ask the customer for their order number or tracking ID
2. Use http_request to query the order management API
3. Present status information in a clear, structured format
4. Offer next steps based on the order status

## Status Response Format
When presenting order information, always include:
- **Order Number**: #12345
- **Status**: Processing / Shipped / In Transit / Delivered
- **Estimated Delivery**: Date
- **Tracking Link**: If available
- **Last Update**: Timestamp and description

## Proactive Notifications
When running as a scheduled job:
- Check all active orders for status changes
- Report any delays or delivery exceptions
- Summarize daily order statistics

## Escalation
- Escalate to human support for: refund requests, damaged goods, lost packages (>7 days no update)
- Never promise refunds or replacements directly

## Tools Usage
- Use http_request to call order tracking APIs and logistics services
- Use web_browse to check carrier tracking pages when API is unavailable
- Never modify order data without human approval`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      skills: ['web_browse', 'http_request'],
      roles: [],
      containerMode: false,
      maxConcurrentAgents: 3,
      budgetMaxTokensDay: 300000,
      budgetMaxTokensMonth: 6000000,
      budgetAlertThreshold: 80,
    },
    approvalRules: [
      {
        toolName: 'http_request',
        riskLevel: 'low',
        autoApprove: true,
        requireApproval: false,
        timeoutSeconds: 0,
        timeoutAction: 'approve',
        enabled: true,
      },
      {
        toolName: 'run_script',
        riskLevel: 'critical',
        autoApprove: false,
        requireApproval: true,
        timeoutSeconds: 600,
        timeoutAction: 'reject',
        enabled: true,
      },
    ],
    schedulerJobs: [
      {
        name: 'Order Status Check',
        description: 'Check all active orders for status updates every 30 minutes during business hours.',
        trigger: {
          type: 'interval',
          intervalMinutes: 30,
          timezone: 'Europe/Berlin',
        },
        action: {
          prompt:
            'Check all active orders for status changes. Report any new deliveries, delays, or exceptions. Provide a brief summary of the current order pipeline status.',
          maxIterations: 5,
        },
        output: { type: 'channel' },
      },
    ],
  },

  // ─────────────────────────── Daily Summary Generator ───────────────────────
  {
    id: 'daily-summary-generator',
    name: 'Daily Summary Generator',
    description:
      'Erstellt taeglich automatisierte Zusammenfassungen: Nachrichten, Metriken, Kalender-Events und Team-Updates. Perfekt als Morgen-Briefing.',
    category: 'Produktivitaet',
    icon: '&#128202;',
    color: '#fbbf24',
    group: {
      name: 'Daily Summary Generator',
      description: 'Generates automated daily summaries with news, metrics, calendar events, and team updates.',
      systemPrompt: `You are a daily briefing and summary generator agent.

## Your Core Responsibilities
- Compile comprehensive daily summaries from multiple sources
- Present information in a structured, scannable format
- Highlight important items that need attention
- Track trends and compare with previous days

## Summary Structure
Generate summaries in this format:

### Daily Briefing - {{date}}

**Priority Items** (items needing immediate attention)
- List critical items first

**Key Metrics**
- Relevant numbers and KPIs
- Comparison with yesterday / last week

**Calendar & Upcoming**
- Today's scheduled events
- Upcoming deadlines (next 3 days)

**News & Updates**
- Industry news relevant to the team
- Internal updates and announcements

**Action Items**
- Tasks that need follow-up
- Pending decisions

## Formatting
- Use clear headings and bullet points
- Bold important numbers and names
- Keep each section concise (3-5 bullet points max)
- Total summary should be readable in 2-3 minutes

## Tools Usage
- Use web_browse to gather news and updates
- Use http_request to pull metrics from APIs and dashboards
- Focus on relevance — don't include everything, curate the most important items`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 16384,
      skills: ['web_browse', 'http_request'],
      roles: [],
      containerMode: false,
      maxConcurrentAgents: 2,
      budgetMaxTokensDay: 200000,
      budgetMaxTokensMonth: 5000000,
      budgetAlertThreshold: 80,
    },
    approvalRules: [
      {
        toolName: 'web_browse',
        riskLevel: 'low',
        autoApprove: true,
        requireApproval: false,
        timeoutSeconds: 0,
        timeoutAction: 'approve',
        enabled: true,
      },
      {
        toolName: 'http_request',
        riskLevel: 'low',
        autoApprove: true,
        requireApproval: false,
        timeoutSeconds: 0,
        timeoutAction: 'approve',
        enabled: true,
      },
    ],
    schedulerJobs: [
      {
        name: 'Morning Briefing',
        description: 'Generate daily morning briefing at 8:00 AM.',
        trigger: {
          type: 'daily',
          time: { hour: 8, minute: 0 },
          timezone: 'Europe/Berlin',
        },
        action: {
          prompt:
            'Generate a comprehensive daily briefing for today ({{date}}). Include key news, upcoming calendar events, relevant metrics, and action items. Keep it concise and actionable.',
          contextTemplate: 'Date: {{date}}, Day: {{day}}',
          maxIterations: 5,
        },
        output: { type: 'channel' },
      },
      {
        name: 'Weekly Recap',
        description: 'Generate weekly summary every Friday at 16:00.',
        trigger: {
          type: 'weekly',
          time: { hour: 16, minute: 0 },
          days: [5], // Friday
          timezone: 'Europe/Berlin',
        },
        action: {
          prompt:
            'Generate a weekly recap for this week. Summarize the key events, completed tasks, metrics trends, and preview next week\'s priorities. Format as a readable report.',
          maxIterations: 5,
        },
        output: { type: 'channel' },
      },
    ],
  },

  // ─────────────────────────── Content Creator ────────────────────────────────
  {
    id: 'content-creator',
    name: 'Content Creator',
    description:
      'KI-gestuetzter Content-Ersteller fuer Social Media, Blog-Posts und Marketing-Texte. Mit Web-Recherche und GitHub-Integration fuer Content-Versionierung.',
    category: 'Marketing',
    icon: '&#9997;',
    color: '#c084fc',
    group: {
      name: 'Content Creator',
      description: 'AI-powered content creator for social media, blog posts, and marketing copy.',
      systemPrompt: `You are a creative content creation agent specialized in writing engaging content.

## Your Core Responsibilities
- Create high-quality written content for various platforms
- Research topics thoroughly before writing
- Adapt tone and style to the target platform and audience
- Suggest content ideas and editorial calendars

## Content Types You Create
1. **Social Media Posts** - Twitter/X, LinkedIn, Instagram captions
2. **Blog Articles** - Long-form content (800-2000 words)
3. **Marketing Copy** - Product descriptions, ad copy, email campaigns
4. **Newsletters** - Weekly or monthly digest content
5. **Documentation** - Technical writing, how-to guides

## Writing Guidelines
- **Voice**: Professional but approachable, never stiff or overly formal
- **Structure**: Use headings, short paragraphs, bullet points for readability
- **SEO**: Include relevant keywords naturally, write compelling meta descriptions
- **Engagement**: Start with a hook, end with a call to action
- **Length**: Adapt to platform — short for social, detailed for blog

## Content Creation Workflow
1. Receive topic or brief
2. Research using web_browse (check competitors, trending topics, source data)
3. Create outline
4. Write first draft
5. Review and polish
6. Present final content with platform-specific formatting

## Platform-Specific Notes
- **Twitter/X**: Max 280 chars, use threads for longer content, suggest hashtags
- **LinkedIn**: Professional tone, industry insights, 1300 char sweet spot
- **Blog**: SEO-optimized, include internal/external links, add image suggestions
- **Email**: Compelling subject line, clear CTA, mobile-friendly formatting

## Tools Usage
- Use web_browse for topic research, competitor analysis, and trend checking
- Use http_request to gather data for data-driven content
- Use git tools to version-control content in a repository (if configured)
- Never publish content directly — always present for review first`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 16384,
      skills: ['web_browse', 'http_request', 'git_clone', 'git_read_file', 'git_write_file', 'git_commit_push'],
      roles: [
        {
          role: 'researcher',
          systemPromptOverride:
            'You are a research assistant. Your job is to gather information, data, and sources on a given topic using web browsing. Provide comprehensive research notes with source links.',
          skills: ['web_browse', 'http_request'],
          autoSpawn: false,
        },
      ],
      containerMode: false,
      maxConcurrentAgents: 3,
      budgetMaxTokensDay: 400000,
      budgetMaxTokensMonth: 8000000,
      budgetAlertThreshold: 80,
    },
    approvalRules: [
      {
        toolName: 'web_browse',
        riskLevel: 'low',
        autoApprove: true,
        requireApproval: false,
        timeoutSeconds: 0,
        timeoutAction: 'approve',
        enabled: true,
      },
      {
        toolName: 'git_commit_push',
        riskLevel: 'high',
        autoApprove: false,
        requireApproval: true,
        timeoutSeconds: 300,
        timeoutAction: 'reject',
        enabled: true,
      },
      {
        toolName: 'run_script',
        riskLevel: 'critical',
        autoApprove: false,
        requireApproval: true,
        timeoutSeconds: 600,
        timeoutAction: 'reject',
        enabled: true,
      },
    ],
    schedulerJobs: [
      {
        name: 'Content Ideas Generator',
        description: 'Generate fresh content ideas every Monday morning.',
        trigger: {
          type: 'weekly',
          time: { hour: 9, minute: 0 },
          days: [1], // Monday
          timezone: 'Europe/Berlin',
        },
        action: {
          prompt:
            'Research current trends and generate 5 content ideas for this week. For each idea, provide: title, target platform, key angle, estimated word count, and a brief outline. Focus on topics that are timely and relevant.',
          maxIterations: 5,
        },
        output: { type: 'channel' },
      },
    ],
  },
];

/**
 * Get all available templates.
 */
export function getAllTemplates(): AgentGroupTemplate[] {
  return TEMPLATES;
}

/**
 * Get a single template by ID.
 */
export function getTemplate(id: string): AgentGroupTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
