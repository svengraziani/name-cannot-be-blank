# Plan: Agent-to-Agent Protocol, Skill Symlinks, Agent-Gruppen & Scheduler

## Status Quo

Das Loop Gateway hat:
- **Tool Registry** (`src/agent/tools/registry.ts`) mit 3 Built-in Tools (`web_browse`, `run_script`, `http_request`)
- **Zwei Ausführungsmodi**: Direct Mode (in-process) und Container Mode (isolierte Docker Container)
- **Container Mode** unterstützt aktuell **keine Tools** - nur einfache Text-Messages
- **Loop Mode** für autonome Tasks (Plan/Build Pattern)
- Tools sind fest im Code registriert (`registerBuiltinTools()` in `index.ts`)
- **Channels** (Telegram, WhatsApp, Email) können optional eine `tools`-Liste in ihrer Config haben (`manager.ts:147`)
- **Kein Konzept von Agent-Gruppen** - jeder Channel nutzt denselben globalen Agent
- **Kein Scheduler** - nur manuelle Loop Tasks

---

## Teil 1: Zentrale Skill-Ebene mit Symlinks

### Problem
- Skills/Tools sind fest im Code verdrahtet (`src/agent/tools/`)
- Container-Agents haben keinen Zugriff auf Tools
- Neue Skills erfordern Code-Änderungen und Rebuild
- Kein dynamisches Laden oder Teilen von Skills zwischen Agents

### Lösung: Zentrales Skill-Verzeichnis mit Volume-Mounts

```
/data/skills/                          # Zentrales Skill-Verzeichnis (persistent volume)
├── _registry.json                     # Skill-Manifest: welche Skills aktiv sind
├── web-browse/
│   ├── skill.json                     # Metadata: name, description, inputSchema
│   └── handler.js                     # Ausführbare Skill-Logik (Node.js)
├── run-script/
│   ├── skill.json
│   └── handler.js
├── http-request/
│   ├── skill.json
│   └── handler.js
└── custom-skill/                      # Benutzerdefinierte Skills
    ├── skill.json
    └── handler.js
```

### skill.json Format
```json
{
  "name": "web_browse",
  "description": "Browse a web page and extract content",
  "version": "1.0.0",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL to browse" }
    },
    "required": ["url"]
  },
  "handler": "./handler.js",
  "containerCompatible": true
}
```

### Symlink-Strategie für Container

```
# docker-compose.yml - Skills als Read-Only Volume in Container mounten
services:
  gateway:
    volumes:
      - skills-data:/data/skills          # Gateway verwaltet Skills zentral

  # Beim Container-Start werden Skills reingemountet:
  # docker run ... -v skills-data:/skills:ro ...
```

Anstatt physische Symlinks zu verwenden (die in Docker-Volumes problematisch sind), nutzen wir **Bind Mounts** als "logische Symlinks":

1. **Gateway** schreibt Skills nach `/data/skills/`
2. **Agent-Container** bekommen `/data/skills/` als Read-Only Volume gemountet
3. Der `runner.js` im Container liest Skills dynamisch aus dem gemounteten Verzeichnis

### Implementierungsschritte

1. **`src/agent/skills/` Modul erstellen**
   - `skill-loader.ts` - Lädt Skills aus `/data/skills/` dynamisch
   - `skill-schema.ts` - TypeScript-Typen für `skill.json`
   - Bestehende Built-in Tools nach `/data/skills/` exportieren (Migration)

2. **`ToolRegistry` erweitern**
   - `loadFromDirectory(dir: string)` Methode hinzufügen
   - Hot-Reload: FileWatcher auf `/data/skills/` für Live-Updates
   - Skills können per `_registry.json` aktiviert/deaktiviert werden

3. **Container-Runner erweitern** (`container-runner.ts`)
   - Skills-Volume im `docker run` Command mounten: `-v skills-data:/skills:ro`
   - Skill-Liste als Teil des stdin-Payloads übergeben

4. **`agent-runner/runner.js` erweitern**
   - Skills aus `/skills/` laden
   - Tool-Use Loop implementieren (wie im Direct Mode)
   - Tool-Ergebnisse über stdout zurückgeben

5. **API-Endpunkte für Skill-Management**
   - `GET /api/skills` - Alle verfügbaren Skills auflisten
   - `POST /api/skills` - Neuen Skill hochladen
   - `PUT /api/skills/:name` - Skill aktualisieren
   - `DELETE /api/skills/:name` - Skill entfernen
   - `POST /api/skills/:name/toggle` - Skill aktivieren/deaktivieren

6. **UI: Skills-Tab im Dashboard**
   - Liste aller Skills mit Status
   - Upload-Formular für neue Skills
   - Inline-Editor für `skill.json`

---

## Teil 2: Agent-to-Agent Protocol (A2A)

### Problem
- Agents arbeiten isoliert - keine Kommunikation zwischen Agents
- Komplexe Tasks können nicht aufgeteilt werden
- Kein Delegation-Pattern (ein Agent gibt Teilaufgabe an spezialisierten Agent)
- Kein Feedback-Loop zwischen Agents

### Lösung: A2A Message Protocol

Ein leichtgewichtiges Protokoll, das Agent-zu-Agent-Kommunikation über einen Message Bus ermöglicht.

### Architektur

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│  Agent A     │────▶│  A2A Message Bus │◀────│  Agent B     │
│  (Planner)   │◀────│  (Gateway)       │────▶│  (Builder)   │
└─────────────┘     └────────┬────────┘     └─────────────┘
                             │
                    ┌────────▼────────┐
                    │  Agent C         │
                    │  (Reviewer)      │
                    └─────────────────┘
```

### A2A Message Format

```typescript
interface A2AMessage {
  id: string;                          // UUID
  type: 'request' | 'response' | 'event';
  from: AgentIdentity;                 // Wer sendet
  to: string;                         // Ziel-Agent ID oder '*' für Broadcast
  conversationId: string;             // Gemeinsamer Kontext
  payload: {
    action: string;                   // z.B. "delegate_task", "report_result", "ask_question"
    content: string;                  // Nachrichteninhalt
    metadata?: Record<string, unknown>;
  };
  timestamp: number;
  replyTo?: string;                   // Referenz auf vorherige Message-ID
  ttl?: number;                       // Time-to-live in ms
}

interface AgentIdentity {
  id: string;                          // Unique Agent ID
  role: string;                        // z.B. "planner", "builder", "reviewer"
  capabilities: string[];             // z.B. ["code_generation", "web_browse"]
}
```

### A2A als Tool

Der eleganteste Ansatz: A2A als Tool im bestehenden Tool-System registrieren.

```typescript
// Tool: delegate_task
{
  name: "delegate_task",
  description: "Delegate a sub-task to another agent with a specific role",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string", description: "Agent role: planner, builder, reviewer, researcher" },
      task: { type: "string", description: "Task description" },
      context: { type: "string", description: "Relevant context from current work" },
      waitForResult: { type: "boolean", description: "Wait for the delegated agent to complete" }
    },
    required: ["role", "task"]
  }
}

// Tool: broadcast_event
{
  name: "broadcast_event",
  description: "Broadcast an event to all active agents",
  inputSchema: {
    type: "object",
    properties: {
      event: { type: "string", description: "Event type" },
      data: { type: "string", description: "Event data" }
    },
    required: ["event", "data"]
  }
}
```

### Agent Rollen & Capabilities

```typescript
interface AgentRole {
  id: string;
  name: string;                       // z.B. "planner", "builder", "reviewer"
  systemPrompt: string;               // Rollenspezifischer System Prompt
  tools: string[];                    // Welche Tools diese Rolle nutzen darf
  maxConcurrent: number;              // Max parallele Instanzen
}
```

Vordefinierte Rollen:
- **Planner**: Erstellt Pläne, zerlegt komplexe Tasks
- **Builder**: Führt Code-generierung/-änderung aus
- **Reviewer**: Prüft Ergebnisse, gibt Feedback
- **Researcher**: Web-Recherche, Informationssammlung

### Implementierungsschritte

1. **`src/agent/a2a/` Modul erstellen**
   - `protocol.ts` - Message-Typen und Serialisierung
   - `bus.ts` - In-Memory Message Bus mit EventEmitter
   - `router.ts` - Message Routing (direct, broadcast, role-based)
   - `agent-identity.ts` - Agent-Registrierung und Capabilities

2. **Agent Spawning erweitern**
   - Neue Agents on-demand starten (Direct oder Container)
   - Agent-Pool für häufig genutzte Rollen
   - Lifecycle Management (start, stop, health-check)

3. **A2A Tools registrieren**
   - `delegate_task` - Task an anderen Agent delegieren
   - `broadcast_event` - Event an alle Agents
   - `query_agents` - Verfügbare Agents/Rollen abfragen

4. **Message Persistence** (SQLite)
   - Neue Tabelle `a2a_messages` für Nachrichtenverlauf
   - Verknüpfung mit bestehenden `agent_runs`
   - Query-Interface für Debugging/Monitoring

5. **Container-Unterstützung**
   - A2A Messages über stdin/stdout in Container-Mode
   - Polling-Mechanismus: Container fragt Gateway nach neuen Messages
   - Alternative: Minimaler HTTP-Endpoint im Container für Push

6. **API-Endpunkte**
   - `GET /api/agents` - Aktive Agents und ihre Rollen
   - `POST /api/agents/spawn` - Neuen Agent mit Rolle starten
   - `GET /api/a2a/messages` - A2A Message-Log
   - `GET /api/a2a/conversations/:id` - Messages einer A2A-Konversation

7. **UI: Agent Orchestration Dashboard**
   - Visualisierung aktiver Agents und ihrer Verbindungen
   - Message-Flow zwischen Agents (Live-Stream)
   - Agent spawnen/stoppen über UI

---

## Teil 3: Zusammenspiel beider Features

### Workflow-Beispiel: Multi-Agent Task

```
User schickt Message via Telegram:
  "Implementiere OAuth2 für die Login-Seite"

1. Gateway empfängt Message → startet Primary Agent (Planner-Rolle)

2. Planner-Agent nutzt `delegate_task` Tool:
   - Delegiert "OAuth2 Provider Recherche" an Researcher-Agent
   - Researcher lädt `web_browse` Skill aus /data/skills/
   - Researcher gibt Ergebnis zurück via A2A

3. Planner erstellt Plan basierend auf Recherche-Ergebnis

4. Planner delegiert Teilaufgaben an Builder-Agents:
   - Builder A: Backend OAuth2 Flow (nutzt `run_script` Skill)
   - Builder B: Frontend Login Component

5. Planner delegiert Review an Reviewer-Agent:
   - Reviewer prüft Code beider Builder
   - Gibt Feedback via A2A zurück

6. Planner fasst alles zusammen → antwortet dem User
```

### Geteilte Skills zwischen Agents via Symlinks/Volumes

```yaml
# docker-compose.yml (erweitert)
volumes:
  skills-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ./skills    # Lokales Skills-Verzeichnis

services:
  gateway:
    volumes:
      - skills-data:/data/skills         # RW für Verwaltung

  # Agent-Container erhalten Skills automatisch:
  # container-runner.ts fügt hinzu:
  #   -v skills-data:/skills:ro
```

---

## Teil 4: Agent-Gruppen & Channel-Binding

### Problem
- Aktuell nutzt jeder Channel denselben globalen Agent mit demselben System-Prompt
- Keine Möglichkeit, spezialisierte Agent-Teams einem Channel zuzuweisen
- Channels haben nur eine optionale `tools`-Liste, aber kein Agent-Profil
- Man kann nicht sagen: "Dieser Telegram-Bot soll ein Researcher-Team sein, jener ein Support-Team"

### Lösung: Agent-Gruppen (Agent Groups)

Eine Agent-Gruppe definiert ein Team von Agents mit spezifischen Rollen, Skills und einem gemeinsamen System-Prompt. Channels werden an eine Agent-Gruppe gebunden.

### Datenmodell

```typescript
interface AgentGroup {
  id: string;                          // UUID
  name: string;                        // z.B. "Support Team", "Dev Team", "Research Squad"
  description: string;
  systemPrompt: string;                // Gruppen-übergreifender System-Prompt

  // AI Einstellungen (pro Gruppe im UI konfigurierbar)
  apiKey?: string;                     // Eigener API Key (verschlüsselt in DB)
                                       // Fallback: globaler ANTHROPIC_API_KEY aus .env
  model: string;                       // Pro Gruppe wählbar (Dropdown im UI)
  maxTokens: number;

  // Budget (pro Gruppe im UI einstellbar, 0 = unbegrenzt)
  budgetConfig: {
    maxTokensPerDay: number;
    maxTokensPerMonth: number;
    alertThreshold: number;            // Warnung bei X% (z.B. 80)
  };

  // Welche Skills diese Gruppe nutzen darf
  skills: string[];                    // z.B. ["web_browse", "http_request"]

  // Welche Agent-Rollen in dieser Gruppe aktiv sind
  roles: AgentGroupRole[];

  // Container-Mode Einstellungen pro Gruppe
  containerMode: boolean;
  maxConcurrentAgents: number;

  createdAt: string;
  updatedAt: string;
}

interface AgentGroupRole {
  role: string;                        // z.B. "planner", "builder"
  systemPromptOverride?: string;       // Optionaler Override des Gruppen-Prompts
  skills: string[];                    // Zusätzliche Skills nur für diese Rolle
  autoSpawn: boolean;                  // Rolle automatisch starten bei Gruppenzuweisung
}
```

### Channel-Binding

```typescript
// Erweiterung der Channel-Config
interface ChannelConfig {
  // ... bestehende Config (token, allowedUsers, etc.)
  agentGroupId?: string;               // Zugewiesene Agent-Gruppe
  // Fallback: wenn keine Gruppe, nutze globalen Default-Agent
}
```

### Architektur

```
┌──────────────────────────────────────────────────────────────┐
│  Channel: Telegram "Kunden-Support"                          │
│  → Agent-Gruppe: "Support Team"                              │
│    ├── Rolle: Planner (Skills: delegate_task)                │
│    ├── Rolle: Researcher (Skills: web_browse, http_request)  │
│    └── Rolle: Responder (Skills: -)                          │
├──────────────────────────────────────────────────────────────┤
│  Channel: Telegram "Dev-Bot"                                 │
│  → Agent-Gruppe: "Dev Team"                                  │
│    ├── Rolle: Planner (Skills: delegate_task)                │
│    ├── Rolle: Builder (Skills: run_script, http_request)     │
│    └── Rolle: Reviewer (Skills: web_browse)                  │
├──────────────────────────────────────────────────────────────┤
│  Channel: Email "info@..."                                   │
│  → Agent-Gruppe: "Simple Responder"                          │
│    └── Rolle: Responder (Skills: web_browse)                 │
└──────────────────────────────────────────────────────────────┘
```

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS agent_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  system_prompt TEXT NOT NULL,
  api_key_encrypted TEXT,                       -- AES-256 verschlüsselt, NULL = globaler Key
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  max_tokens INTEGER NOT NULL DEFAULT 8192,
  skills TEXT NOT NULL DEFAULT '[]',           -- JSON array of skill names
  roles TEXT NOT NULL DEFAULT '[]',            -- JSON array of AgentGroupRole
  container_mode INTEGER NOT NULL DEFAULT 0,
  max_concurrent_agents INTEGER NOT NULL DEFAULT 3,
  budget_max_tokens_day INTEGER NOT NULL DEFAULT 0,    -- 0 = unbegrenzt
  budget_max_tokens_month INTEGER NOT NULL DEFAULT 0,  -- 0 = unbegrenzt
  budget_alert_threshold INTEGER NOT NULL DEFAULT 80,  -- Warnung bei X%
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channel bekommt agent_group_id Spalte
ALTER TABLE channels ADD COLUMN agent_group_id TEXT
  REFERENCES agent_groups(id) ON DELETE SET NULL;
```

### Dashboard: Agent-Skill Matrix

Im Dashboard wird pro Agent-Gruppe sichtbar:
- Welche Rollen aktiv sind
- Welche Skills jede Rolle hat
- Welchem Channel die Gruppe zugewiesen ist
- Live-Status: welche Agents gerade laufen, Token-Verbrauch pro Gruppe

```
┌─ Dashboard: Agent-Gruppen ──────────────────────────────────┐
│                                                              │
│  ┌─ Support Team ──────────────────────────────────────────┐ │
│  │  Channels: Telegram "Kunden-Bot"                        │ │
│  │  Model: claude-sonnet-4                                 │ │
│  │                                                          │ │
│  │  Rollen:               Skills:                          │ │
│  │  ├── Planner          [delegate_task]                   │ │
│  │  ├── Researcher       [web_browse, http_request]    ●   │ │
│  │  └── Responder        [-]                               │ │
│  │                                                          │ │
│  │  Aktive Agents: 1/3   |  Heute: 2.4k Tokens            │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Dev Team ──────────────────────────────────────────────┐ │
│  │  Channels: Telegram "Dev-Bot", Email "dev@..."          │ │
│  │  ...                                                     │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Implementierungsschritte

1. **SQLite Schema erweitern** (`src/db/sqlite.ts`)
   - `agent_groups` Tabelle
   - `channels.agent_group_id` FK-Spalte
   - CRUD-Funktionen für Agent-Gruppen

2. **Agent-Group Manager** (`src/agent/groups/`)
   - `group-manager.ts` - Lifecycle: Gruppe erstellen, Skills zuweisen, Channel binden
   - `group-resolver.ts` - Bei eingehender Message: Channel → Gruppe → richtige Rollen/Skills auflösen

3. **Channel-Manager erweitern** (`src/channels/manager.ts`)
   - `startChannel()` holt jetzt die Agent-Gruppe statt globaler Config
   - `processMessage()` erhält Gruppen-Context (System-Prompt, Skills, Model)

4. **API-Endpunkte**
   - `GET /api/agent-groups` - Alle Gruppen mit Rollen und Skills
   - `POST /api/agent-groups` - Neue Gruppe erstellen
   - `PUT /api/agent-groups/:id` - Gruppe aktualisieren
   - `DELETE /api/agent-groups/:id` - Gruppe löschen
   - `POST /api/agent-groups/:id/assign/:channelId` - Gruppe an Channel binden
   - `GET /api/agent-groups/:id/stats` - Live-Statistiken der Gruppe

5. **UI: Agent-Gruppen Tab**
   - Gruppen-Übersicht mit Skill-Matrix
   - Drag-and-Drop: Skills zu Rollen zuweisen
   - Channel-Zuordnung per Dropdown
   - Live Token-Verbrauch pro Gruppe

---

## Teil 5: Cron-Scheduler & Kalender-Integration

### Problem
- Loop Tasks können nur manuell gestartet werden
- Keine wiederkehrenden Aufgaben (z.B. "Jeden Morgen News zusammenfassen")
- Kein Kalender-Konzept - Agents reagieren nur auf eingehende Messages
- Keine Möglichkeit, zeitgesteuert Agent-Gruppen zu aktivieren

### Lösung: Agent-Scheduler mit Kalender

Ein Scheduler-System das:
- Cron-ähnliche wiederkehrende Tasks ermöglicht
- Kalender-Integration bietet (iCal, Google Calendar)
- Tasks an Agent-Gruppen bindet
- Ergebnisse an Channels oder externe Ziele liefert

### Architektur

```
┌─────────────────────────────────────────────────────────────┐
│  Scheduler Engine                                            │
│  ├── Cron Jobs (node-cron Pattern)                          │
│  ├── Calendar Sync (iCal Polling)                           │
│  └── One-time Scheduled Tasks                               │
├─────────────────────────────────────────────────────────────┤
│                        │                                     │
│                        ▼                                     │
│  ┌─ Schedule Trigger ────────────────────────────────────┐  │
│  │  Cron: "0 8 * * *" (täglich 8:00)                    │  │
│  │  → Agent-Gruppe: "Research Squad"                      │  │
│  │  → Prompt: "Fasse die Top-Tech-News zusammen"          │  │
│  │  → Output: Telegram Channel "Daily Digest"             │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Calendar Event ─────────────────────────────────────┐   │
│  │  Kalender: "Team Standup"                             │   │
│  │  Event: Mo-Fr 09:00 "Daily Standup"                   │   │
│  │  → Agent-Gruppe: "Standup Bot"                         │   │
│  │  → Action: Sammle Git-Commits, erstelle Summary        │   │
│  │  → Output: Slack/Telegram "Dev-Channel"                │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Datenmodell

```typescript
interface ScheduledJob {
  id: string;                          // UUID
  name: string;                        // z.B. "Morning News Digest"
  description: string;

  // Trigger: wann soll der Job laufen?
  trigger: {
    type: 'cron' | 'calendar' | 'once' | 'interval';
    // Cron: Standard Cron-Expression
    cron?: string;                     // z.B. "0 8 * * 1-5" (Mo-Fr 8:00)
    // Calendar: iCal URL die gepollt wird
    calendarUrl?: string;              // z.B. "https://calendar.google.com/...ical"
    calendarEventFilter?: string;      // Regex-Filter auf Event-Titel
    // Once: einmaliger Zeitpunkt
    runAt?: string;                    // ISO datetime
    // Interval: alle X Minuten
    intervalMinutes?: number;
  };

  // Was soll passieren?
  action: {
    agentGroupId: string;              // Welche Agent-Gruppe soll den Job bearbeiten
    prompt: string;                    // Task-Prompt für den Agent
    contextTemplate?: string;          // Template mit Variablen: {{date}}, {{event_title}}, etc.
    maxIterations: number;             // Loop-Iterationen (wie bei Loop Tasks)
  };

  // Wohin soll das Ergebnis?
  output: {
    type: 'channel' | 'webhook' | 'file' | 'email';
    channelId?: string;                // An welchen Channel senden
    chatId?: string;                   // Spezifischer Chat im Channel
    webhookUrl?: string;               // Externe URL für Webhook-Delivery
    filePath?: string;                 // Datei auf Disk schreiben
    emailTo?: string;                  // E-Mail Empfänger
  };

  // Status
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'error';
  lastRunOutput?: string;
  nextRunAt?: string;
  runCount: number;

  createdAt: string;
  updatedAt: string;
}

interface CalendarSource {
  id: string;
  name: string;                        // z.B. "Team-Kalender"
  url: string;                         // iCal URL
  pollIntervalMinutes: number;         // Wie oft synchronisieren (default: 15)
  agentGroupId: string;                // "Besitzer" Agent-Gruppe
  syncedAt?: string;                   // Letzte Sync-Zeit
  events: CalendarEvent[];             // Gecachte Events
}

interface CalendarEvent {
  uid: string;                         // iCal UID
  title: string;
  description?: string;
  start: string;                       // ISO datetime
  end: string;
  recurrence?: string;                 // RRULE
  triggeredJobId?: string;             // Verknüpfter Scheduled Job
}
```

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  trigger_config TEXT NOT NULL,         -- JSON: trigger object
  action_config TEXT NOT NULL,          -- JSON: action object
  output_config TEXT NOT NULL,          -- JSON: output object
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_run_status TEXT,
  last_run_output TEXT,
  next_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 15,
  agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,                    -- iCal UID
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  recurrence TEXT,
  triggered_job_id TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',  -- running | success | error
  output TEXT,
  error TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

### Workflow-Beispiele

**Beispiel 1: Täglicher News Digest**
```
Scheduled Job: "Morning Tech News"
  Trigger: Cron "0 8 * * 1-5" (Mo-Fr 8:00)
  Agent-Gruppe: "Research Squad"
    → Researcher-Agent browst tech news sites
    → Planner-Agent fasst zusammen
  Output: Telegram Channel "Daily Digest"
```

**Beispiel 2: Meeting-Vorbereitung via Kalender**
```
Calendar Source: Google Calendar "Team"
  Poll: alle 15 Minuten
  Agent-Gruppe: "Meeting Prep Bot"

  Wenn Event "Sprint Planning" in 30 Min startet:
    → Agent liest letzte Sprint-Tickets (via http_request zu Jira)
    → Erstellt Agenda-Vorschlag
    → Sendet an Telegram "Dev-Channel"
```

**Beispiel 3: Wiederkehrender Report**
```
Scheduled Job: "Weekly Token Usage Report"
  Trigger: Cron "0 18 * * 5" (Freitag 18:00)
  Agent-Gruppe: "Analytics Bot"
    → Agent liest /api/usage/daily (via http_request)
    → Erstellt Report mit Trends
  Output: Email an admin@company.com
```

**Beispiel 4: Kalender-gebundener Agent**
```
Calendar Source: "Sven's Kalender"
  Besitzer: Agent-Gruppe "Personal Assistant"

  Der Agent kennt den Kalender und kann:
  - Proaktiv an Termine erinnern
  - Konflikte erkennen
  - Freiräume für Deep Work vorschlagen
  - Bei Channel-Fragen "Wann habe ich Zeit?" den Kalender konsultieren
```

### Implementierungsschritte

1. **Scheduler Engine** (`src/scheduler/`)
   - `scheduler.ts` - Haupt-Engine mit `node-cron` Integration
   - `job-executor.ts` - Führt Jobs aus: Agent-Gruppe starten → Prompt senden → Output routen
   - `calendar-sync.ts` - iCal Polling und Event-Parsing (via `ical.js` oder `node-ical`)
   - `trigger-evaluator.ts` - Entscheidet wann Jobs feuern (Cron, Calendar-Events, Einmalig)

2. **Calendar als Agent-Context**
   - Kalender-Events werden als zusätzlicher Context in den System-Prompt der Agent-Gruppe injiziert
   - Template-System: `{{upcoming_events}}`, `{{today_schedule}}`, `{{next_event}}`
   - Agent kann per Tool den Kalender abfragen: `query_calendar` Tool

3. **Output-Router** (`src/scheduler/output-router.ts`)
   - Ergebnis eines Jobs an den richtigen Kanal leiten
   - Channel-Output: Message an Telegram/WhatsApp/Email senden
   - Webhook-Output: HTTP POST an externe URL
   - File-Output: Ergebnis auf Disk schreiben

4. **SQLite Schema erweitern** (`src/db/sqlite.ts`)
   - Tabellen: `scheduled_jobs`, `calendar_sources`, `calendar_events`, `job_runs`
   - CRUD-Funktionen und Job-Run Logging

5. **API-Endpunkte**
   - `GET /api/scheduler/jobs` - Alle Scheduled Jobs
   - `POST /api/scheduler/jobs` - Neuen Job erstellen
   - `PUT /api/scheduler/jobs/:id` - Job bearbeiten
   - `DELETE /api/scheduler/jobs/:id` - Job löschen
   - `POST /api/scheduler/jobs/:id/toggle` - Job aktivieren/deaktivieren
   - `POST /api/scheduler/jobs/:id/run` - Job manuell triggern
   - `GET /api/scheduler/jobs/:id/runs` - Job-Run Historie
   - `GET /api/scheduler/calendars` - Alle Kalender-Quellen
   - `POST /api/scheduler/calendars` - Kalender hinzufügen
   - `POST /api/scheduler/calendars/:id/sync` - Kalender manuell synchronisieren
   - `DELETE /api/scheduler/calendars/:id` - Kalender entfernen

6. **UI: Scheduler & Kalender Tab**
   - Cron-Job Übersicht mit nächster Ausführungszeit
   - Kalender-Ansicht (Monats/Wochen-View) mit Events und zugeordneten Agent-Gruppen
   - Job-Run Historie mit Logs
   - Visueller Cron-Builder (kein manuelles Cron-Syntax schreiben nötig)

---

## Teil 6: Gesamtarchitektur (alle Features zusammen)

### Erweitertes Architektur-Diagramm

```
┌─────────────────────────────────────────────────────────────────┐
│                        LOOP GATEWAY                              │
│                                                                  │
│  ┌─ Scheduler Engine ─────────────────────────────────────────┐ │
│  │  Cron Jobs  │  Calendar Sync  │  One-time Tasks            │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                          │                                       │
│  ┌─ Channels ────────────┼────────────────────────────────────┐ │
│  │  Telegram │ WhatsApp │ Email                               │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                          │                                       │
│                          ▼                                       │
│  ┌─ Agent-Gruppen Router ─────────────────────────────────────┐ │
│  │  Channel/Job → Agent-Gruppe auflösen                       │ │
│  │  Gruppe → Rollen, Skills, System-Prompt bestimmen          │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                          │                                       │
│                          ▼                                       │
│  ┌─ Agent-Gruppen ───────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌─ "Support Team" ─────┐  ┌─ "Dev Team" ──────────────┐ │  │
│  │  │ Planner  → [delegate] │  │ Planner → [delegate]       │ │  │
│  │  │ Researcher→ [browse]  │  │ Builder → [run_script]     │ │  │
│  │  │ Responder → []        │  │ Reviewer→ [web_browse]     │ │  │
│  │  └───────────────────────┘  └────────────────────────────┘ │  │
│  │                                                            │  │
│  │            ◄── A2A Message Bus ──►                         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ▼                                       │
│  ┌─ Zentrale Skill-Ebene ────────────────────────────────────┐  │
│  │  /data/skills/ (Volume Mount → Container)                  │  │
│  │  web_browse │ run_script │ http_request │ custom_skills    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ▼                                       │
│  ┌─ Output Router ───────────────────────────────────────────┐  │
│  │  → Channel (Telegram/WhatsApp/Email)                       │  │
│  │  → Webhook (externe URL)                                   │  │
│  │  → File (Disk)                                             │  │
│  │  → Email (SMTP)                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Dashboard ───────────────────────────────────────────────┐  │
│  │  Agent-Gruppen │ Skill-Matrix │ Scheduler │ Kalender      │  │
│  │  Live-Status   │ A2A Messages │ Token-Usage │ Job-Runs    │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Komplettes Workflow-Beispiel

```
08:00 - Cron Job "Morning Digest" feuert
  → Agent-Gruppe "Research Squad" wird aktiviert
  → Researcher-Agent: browst 5 News-Seiten (web_browse Skill)
  → Planner-Agent: fasst zusammen via A2A-Delegation
  → Output-Router: sendet Digest an Telegram Channel "Daily News"

09:00 - Kalender-Event "Sprint Planning" in 30 Min
  → Agent-Gruppe "Meeting Prep Bot" wird getriggert
  → Agent liest Jira-Tickets via http_request Skill
  → Erstellt Agenda, sendet an Telegram "Dev-Channel"

10:30 - User schreibt in Telegram "Dev-Bot": "Review den PR #42"
  → Channel "Dev-Bot" → Agent-Gruppe "Dev Team"
  → Planner delegiert an Builder: "Code lesen" (run_script)
  → Planner delegiert an Reviewer: "Feedback geben"
  → Ergebnis wird in Telegram zurückgesendet

18:00 Freitag - Cron Job "Weekly Report"
  → Agent-Gruppe "Analytics Bot"
  → Agent liest Usage-Daten, erstellt Report
  → Output-Router: sendet als Email an admin@company.com
```

---

## Priorisierung (aktualisiert)

| Phase | Feature | Aufwand | Priorität |
|-------|---------|---------|-----------|
| 1 | Skill-Schema (`skill.json`) & Loader | Mittel | Hoch |
| 2 | Built-in Tools nach `/data/skills/` migrieren | Mittel | Hoch |
| 3 | Container Skills via Volume-Mount | Mittel | Hoch |
| 4 | **Agent-Gruppen Datenmodell & CRUD** | Mittel | Hoch |
| 5 | **Channel-Agent-Gruppen Binding** | Mittel | Hoch |
| 6 | A2A Message-Typen & Bus | Mittel | Hoch |
| 7 | `delegate_task` Tool | Mittel | Hoch |
| 8 | **Scheduler Engine (Cron)** | Mittel | Hoch |
| 9 | Skills API-Endpunkte | Klein | Mittel |
| 10 | Agent Roles & Spawning | Groß | Mittel |
| 11 | A2A in Container Mode | Groß | Mittel |
| 12 | **Kalender-Integration (iCal Sync)** | Mittel | Mittel |
| 13 | **Output-Router (Webhook, Email, File)** | Mittel | Mittel |
| 14 | **Dashboard: Agent-Gruppen & Skill-Matrix** | Groß | Mittel |
| 15 | **Dashboard: Scheduler & Kalender-View** | Groß | Mittel |
| 16 | Hot-Reload & FileWatcher | Klein | Niedrig |

### Empfohlene Umsetzungs-Reihenfolge

**Sprint 1: Foundation** (Skill-System + Agent-Gruppen)
- Phase 1-5: Zentrales Skill-System + Agent-Gruppen + Channel-Binding
- Damit funktioniert: verschiedene Channels mit verschiedenen Agent-Profilen

**Sprint 2: Communication** (A2A Protocol)
- Phase 6-7: Agents können miteinander kommunizieren
- Damit funktioniert: Multi-Agent Workflows innerhalb einer Gruppe

**Sprint 3: Automation** (Scheduler + Kalender)
- Phase 8, 12-13: Zeitgesteuerte Aufgaben + Kalender-Sync
- Damit funktioniert: Agents arbeiten proaktiv statt nur reaktiv

**Sprint 4: Polish** (Dashboard + Container)
- Phase 9-11, 14-16: UI, Container-Support, Hot-Reload
- Damit funktioniert: Vollständige Sichtbarkeit und Verwaltung

## Entschiedene Designfragen

| # | Frage | Entscheidung | Auswirkung |
|---|-------|-------------|------------|
| 1 | **Container-Networking für A2A** | **Gateway als Hub** - alle A2A Messages laufen über den Gateway, keine direkte Container-zu-Container Kommunikation | Einfacher zu debuggen, bessere Sicherheit, automatisches Logging in SQLite, kein Docker-Network-Setup nötig |
| 2 | **Skill-Sicherheit** | **Ja, Sandbox** - benutzerdefinierte Skills laufen sandboxed | `isolated-vm` oder `vm2` für Handler-Ausführung, Built-in Skills dürfen nativ laufen |
| 3 | **A2A Persistenz** | **SQLite** - alle A2A Messages werden persistiert | `a2a_messages` Tabelle, vollständiger Audit-Trail, Dashboard kann historische Flows anzeigen |
| 4 | **Skalierung** | **Single-Node** (vorerst) | EventEmitter-basierter Message Bus reicht, spätere Migration zu Redis/NATS als Option offen halten |
| 5 | **Kalender-Zugriff** | **Lesen + Schreiben** | Phase 1: iCal-URL (Lesen), Phase 2: CalDAV/Google Calendar API (Lesen + Schreiben) |
| 6 | **Scheduler-Timezone** | **Benutzerfreundlich, kein Cron-Syntax** | Visueller Scheduler-Builder im UI (siehe unten) |
| 7 | **Agent-Gruppen Limits** | **Optional, über UI einstellbar** | Budget-Limit pro Gruppe (Tokens/Tag), kann auf 0 = unbegrenzt gesetzt werden |
| 8 | **Kalender-Auth** | **Beides** | iCal-URL als einfacher Einstieg (alle Kalender-Apps exportieren das), OAuth2 für Google Calendar API als Upgrade für Schreibzugriff |

---

## Zusätzliche Designentscheidungen

### API Key & Model pro Agent-Gruppe über UI konfigurierbar

Jede Agent-Gruppe bekommt eigene Einstellungen für API Key und Model, konfigurierbar über das Dashboard:

```typescript
interface AgentGroup {
  // ... bestehende Felder ...
  apiKey?: string;                     // Eigener API Key (verschlüsselt in DB)
                                       // Fallback: globaler ANTHROPIC_API_KEY aus .env
  model: string;                       // Pro Gruppe wählbar (Dropdown im UI)
  maxTokens: number;                   // Pro Gruppe einstellbar
  budgetConfig: {
    maxTokensPerDay: number;           // 0 = unbegrenzt
    maxTokensPerMonth: number;         // 0 = unbegrenzt
    alertThreshold: number;            // Warnung bei X% des Budgets (z.B. 80)
  };
}
```

**UI-Elemente im Agent-Gruppen Editor:**
```
┌─ Agent-Gruppe bearbeiten: "Support Team" ──────────────────┐
│                                                              │
│  Name:        [Support Team              ]                   │
│  Beschreibung:[Kunden-Support via Telegram]                  │
│                                                              │
│  ┌─ AI Einstellungen ─────────────────────────────────────┐ │
│  │  API Key:    [••••••••••••••sk-ant-1234] [Anzeigen]    │ │
│  │              ☐ Globalen Key verwenden (aus .env)        │ │
│  │                                                         │ │
│  │  Model:      [▼ Claude Sonnet 4        ]                │ │
│  │              ├─ Claude Opus 4                            │ │
│  │              ├─ Claude Sonnet 4  ← ausgewählt           │ │
│  │              └─ Claude Haiku 3.5                         │ │
│  │                                                         │ │
│  │  Max Tokens: [8192                     ]                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Budget ───────────────────────────────────────────────┐ │
│  │  Tages-Limit:   [100000    ] Tokens (0 = unbegrenzt)   │ │
│  │  Monats-Limit:  [2000000   ] Tokens (0 = unbegrenzt)   │ │
│  │  Warnung bei:   [80        ] %                          │ │
│  │                                                         │ │
│  │  Verbrauch heute:  23.4k / 100k  ████████░░░░  23%    │ │
│  │  Verbrauch Monat:  412k / 2M     ██░░░░░░░░░░  21%    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  [Speichern]  [Abbrechen]                                    │
└──────────────────────────────────────────────────────────────┘
```

**SQLite Schema Erweiterung:**
```sql
-- agent_groups Tabelle erweitern
ALTER TABLE agent_groups ADD COLUMN api_key_encrypted TEXT;
ALTER TABLE agent_groups ADD COLUMN budget_max_tokens_day INTEGER DEFAULT 0;
ALTER TABLE agent_groups ADD COLUMN budget_max_tokens_month INTEGER DEFAULT 0;
ALTER TABLE agent_groups ADD COLUMN budget_alert_threshold INTEGER DEFAULT 80;
```

**Sicherheit:** API Keys werden mit AES-256 verschlüsselt in der DB gespeichert. Der Encryption Key kommt aus `ENCRYPTION_KEY` in `.env`. Im UI werden Keys nur maskiert angezeigt.

### Benutzerfreundlicher Scheduler (kein Cron-Syntax)

Der Scheduler soll für Nicht-Techniker bedienbar sein. Statt Cron-Expressions nutzen wir einen visuellen Builder:

```
┌─ Neuen Job erstellen ──────────────────────────────────────┐
│                                                              │
│  Name: [Morning Tech News Digest      ]                     │
│                                                              │
│  ┌─ Wann soll der Job laufen? ────────────────────────────┐ │
│  │                                                         │ │
│  │  Wiederholung: (●) Täglich  ( ) Wöchentlich            │ │
│  │                ( ) Monatlich ( ) Einmalig               │ │
│  │                ( ) Alle X Minuten                        │ │
│  │                ( ) Bei Kalender-Event                    │ │
│  │                                                         │ │
│  │  ┌─ Täglich ─────────────────────────────────────────┐ │ │
│  │  │  Uhrzeit:     [08] : [00]                         │ │ │
│  │  │                                                    │ │ │
│  │  │  An welchen Tagen?                                 │ │ │
│  │  │  [✓] Mo  [✓] Di  [✓] Mi  [✓] Do  [✓] Fr         │ │ │
│  │  │  [ ] Sa  [ ] So                                    │ │ │
│  │  │                                                    │ │ │
│  │  │  Zeitzone: [▼ Europe/Berlin (MEZ/MESZ)  ]         │ │ │
│  │  └────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Was soll passieren? ──────────────────────────────────┐ │
│  │  Agent-Gruppe: [▼ Research Squad       ]               │ │
│  │                                                         │ │
│  │  Aufgabe:                                               │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │ Fasse die wichtigsten Tech-News von heute        │  │ │
│  │  │ zusammen. Fokus auf AI, Cloud und Security.      │  │ │
│  │  │ Erstelle eine kurze Zusammenfassung mit Links.   │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Wohin soll das Ergebnis? ─────────────────────────────┐ │
│  │  Ziel: (●) An Channel senden                           │ │
│  │        ( ) Per Email senden                             │ │
│  │        ( ) An Webhook senden                            │ │
│  │        ( ) In Datei speichern                           │ │
│  │                                                         │ │
│  │  Channel: [▼ Telegram "Daily Digest"  ]                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Nächste Ausführung: Montag, 24.02.2026 um 08:00 MEZ        │
│                                                              │
│  [Erstellen]  [Abbrechen]                                    │
└──────────────────────────────────────────────────────────────┘
```

**Kalender-Event Trigger:**
```
┌─ Bei Kalender-Event ──────────────────────────────────────┐
│                                                            │
│  Kalender: [▼ Team-Kalender (Google)     ]                │
│                                                            │
│  Auslöser:                                                 │
│  (●) Vor dem Event   [ 30 ] Minuten vorher                │
│  ( ) Beim Event-Start                                      │
│  ( ) Nach dem Event   [   ] Minuten nachher                │
│                                                            │
│  Filter (optional):                                        │
│  Event-Titel enthält: [Sprint Planning        ]            │
│                                                            │
│  Verfügbare Variablen im Prompt:                           │
│  {{event_title}} {{event_time}} {{event_description}}      │
│  {{event_attendees}} {{event_location}}                    │
└────────────────────────────────────────────────────────────┘
```

**Implementierung:** Das UI generiert intern die Cron-Expression aus den benutzerfreundlichen Eingaben. Der User sieht nie Cron-Syntax. Die Timezone wird pro Job gespeichert und `node-cron` berechnet die nächste Ausführungszeit entsprechend.

```typescript
// Interner Konverter: UI-Input → Cron
function buildCronFromUI(input: ScheduleUIInput): string {
  // Beispiel: Täglich 08:00, Mo-Fr, Europe/Berlin
  // → "0 8 * * 1-5" + timezone: "Europe/Berlin"
}

interface ScheduleUIInput {
  type: 'daily' | 'weekly' | 'monthly' | 'once' | 'interval' | 'calendar_event';
  time?: { hour: number; minute: number };
  days?: number[];                     // 0=So, 1=Mo, ..., 6=Sa
  timezone: string;                    // IANA timezone, z.B. "Europe/Berlin"
  intervalMinutes?: number;
  calendarTrigger?: {
    calendarId: string;
    minutesBefore?: number;
    minutesAfter?: number;
    titleFilter?: string;
  };
}
