# Plan: Agent-to-Agent Protocol & Skill Symlinks

## Status Quo

Das Loop Gateway hat:
- **Tool Registry** (`src/agent/tools/registry.ts`) mit 3 Built-in Tools (`web_browse`, `run_script`, `http_request`)
- **Zwei Ausführungsmodi**: Direct Mode (in-process) und Container Mode (isolierte Docker Container)
- **Container Mode** unterstützt aktuell **keine Tools** - nur einfache Text-Messages
- **Loop Mode** für autonome Tasks (Plan/Build Pattern)
- Tools sind fest im Code registriert (`registerBuiltinTools()` in `index.ts`)

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

## Priorisierung

| Phase | Feature | Aufwand | Priorität |
|-------|---------|---------|-----------|
| 1 | Skill-Schema (`skill.json`) & Loader | Mittel | Hoch |
| 2 | Built-in Tools nach `/data/skills/` migrieren | Mittel | Hoch |
| 3 | Container Skills via Volume-Mount | Mittel | Hoch |
| 4 | A2A Message-Typen & Bus | Mittel | Hoch |
| 5 | `delegate_task` Tool | Mittel | Hoch |
| 6 | Skills API-Endpunkte | Klein | Mittel |
| 7 | Agent Roles & Spawning | Groß | Mittel |
| 8 | A2A in Container Mode | Groß | Mittel |
| 9 | UI Dashboard Erweiterungen | Groß | Niedrig |
| 10 | Hot-Reload & FileWatcher | Klein | Niedrig |

## Offene Fragen

1. **Container-Networking für A2A**: Sollen Agent-Container untereinander kommunizieren können (Docker Network), oder läuft alles über den Gateway als Hub?
2. **Skill-Sicherheit**: Sollen hochgeladene Skills sandboxed ausgeführt werden (z.B. via `vm2` oder isolate)?
3. **Persistenz**: Soll der A2A Message-Bus nur in-memory sein oder alles in SQLite persistiert werden?
4. **Skalierung**: Reicht ein Single-Node Setup oder soll A2A auch über Redis/NATS verteilt werden können?
