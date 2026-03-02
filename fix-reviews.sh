#!/usr/bin/env bash
set -euo pipefail

# ─── Konfiguration ───────────────────────────────────────────────
REPO="svengraziani/name-cannot-be-blank"  # Format: owner/repo
LABEL=""  # optional: nur PRs mit bestimmtem Label
SKIP_EMPTY=true

# ─── Farben ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Abhängigkeiten prüfen ──────────────────────────────────────
for cmd in gh jq claude python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo -e "${RED}Fehler: '$cmd' ist nicht installiert.${NC}"
    case "$cmd" in
      gh)     echo "  brew install gh && gh auth login" ;;
      jq)     echo "  brew install jq" ;;
      claude)   echo "  npm install -g @anthropic-ai/claude-code" ;;
      python3) echo "  brew install python3" ;;
    esac
    exit 1
  fi
done

# ─── Repo bestimmen ─────────────────────────────────────────────
if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null) || {
    echo -e "${RED}Fehler: Konnte Repo nicht ermitteln. Bist du in einem Git-Repo?${NC}"
    exit 1
  }
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  CodeRabbit Review Processor${NC}"
echo -e "${CYAN}  Repo: ${REPO}${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ─── Offene PRs holen ────────────────────────────────────────────
echo -e "${YELLOW}Lade offene Pull Requests...${NC}"

PR_ARGS=(pr list --repo "$REPO" --state open --json number,title,headRefName --limit 100)
if [[ -n "$LABEL" ]]; then
  PR_ARGS+=(--label "$LABEL")
fi

PRS=$(gh "${PR_ARGS[@]}")
PR_COUNT=$(echo "$PRS" | jq 'length')

if [[ "$PR_COUNT" -eq 0 ]]; then
  echo -e "${GREEN}Keine offenen PRs gefunden.${NC}"
  exit 0
fi

echo -e "${GREEN}${PR_COUNT} offene PR(s) gefunden.${NC}"
echo ""

# ─── Aktuellen Branch merken ─────────────────────────────────────
ORIGINAL_BRANCH=$(git branch --show-current)

# ─── PRs verarbeiten ────────────────────────────────────────────
PROCESSED=0
SKIPPED=0

echo "$PRS" | jq -c '.[]' | while read -r pr; do
  PR_NUMBER=$(echo "$pr" | jq -r '.number')
  PR_TITLE=$(echo "$pr" | jq -r '.title')
  PR_BRANCH=$(echo "$pr" | jq -r '.headRefName')

  echo -e "${CYAN}──────────────────────────────────────────────────${NC}"
  echo -e "${CYAN}PR #${PR_NUMBER}: ${PR_TITLE}${NC}"
  echo -e "${CYAN}Branch: ${PR_BRANCH}${NC}"
  echo ""

  # Review-Kommentare holen (PR-Kommentare + Review-Kommentare)
  # gh liefert JSON mit nackten Steuerzeichen in Markdown-Bodies,
  # die jq nicht parsen kann. python3 bereinigt diese zuverlässig.
  sanitize_json() {
    python3 -c "
import sys, re
raw = sys.stdin.buffer.read()
cleaned = re.sub(rb'[\x00-\x08\x0b\x0c\x0e-\x1f]', b' ', raw)
sys.stdout.buffer.write(cleaned)
"
  }

  RAW_COMMENTS=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json comments,reviews 2>/dev/null | sanitize_json || echo '{"comments":[],"reviews":[]}')
  COMMENTS=$(echo "$RAW_COMMENTS" | jq '
    [
      (.comments // [] | .[]? | select(.author.login == "coderabbitai") | {
        type: "comment",
        body: .body,
        created: .createdAt
      }),
      (.reviews // [] | .[]? | select(.author.login == "coderabbitai") | {
        type: "review",
        body: .body,
        created: .submittedAt
      })
    ] | sort_by(.created)
  ' 2>/dev/null || echo "[]")

  # Review-Kommentare auf einzelne Dateien (inline comments)
  # Hier ist der Login "coderabbitai[bot]" (GitHub API nutzt anderen Namen als gh CLI)
  RAW_REVIEW=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --paginate 2>/dev/null | sanitize_json || echo "[]")
  REVIEW_COMMENTS=$(echo "$RAW_REVIEW" | jq '
    [.[] | select(.user.login == "coderabbitai[bot]") | {
      type: "inline",
      path: .path,
      line: .line,
      body: .body,
      created: .created_at
    }]
  ' 2>/dev/null || echo "[]")

  COMMENT_COUNT=$(echo "$COMMENTS" | jq 'length' 2>/dev/null || echo 0)
  INLINE_COUNT=$(echo "$REVIEW_COMMENTS" | jq 'length' 2>/dev/null || echo 0)
  TOTAL=$((COMMENT_COUNT + INLINE_COUNT))

  if [[ "$TOTAL" -eq 0 ]]; then
    echo -e "${YELLOW}  Keine CodeRabbit-Kommentare gefunden. Überspringe.${NC}"
    echo ""
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo -e "${GREEN}  ${COMMENT_COUNT} Kommentar(e), ${INLINE_COUNT} Inline-Review(s)${NC}"

  # Alles zusammenbauen
  FEEDBACK=$(cat <<PROMPT_END
# CodeRabbit Review für PR #${PR_NUMBER}: ${PR_TITLE}
Branch: ${PR_BRANCH}

## Allgemeine Kommentare
$(echo "$COMMENTS" | jq -r '.[] | "### \(.type) (\(.created))\n\(.body)\n"')

## Inline-Reviews (datei-spezifisch)
$(echo "$REVIEW_COMMENTS" | jq -r '.[] | "### \(.path):\(.line)\n\(.body)\n"')
PROMPT_END
)

  # Branch auschecken
  echo -e "${YELLOW}  Checke Branch '${PR_BRANCH}' aus...${NC}"
  if ! git checkout "$PR_BRANCH" 2>/dev/null; then
    echo -e "${RED}  Konnte Branch '${PR_BRANCH}' nicht auschecken. Überspringe.${NC}"
    echo ""
    continue
  fi

  git pull --ff-only 2>/dev/null || true

  # Claude verarbeiten lassen
  echo -e "${YELLOW}  Übergebe an Claude Code...${NC}"
  echo ""

  echo "$FEEDBACK" | claude -p "
Du bekommst CodeRabbit Review-Feedback für PR #${PR_NUMBER} (${PR_TITLE}).

Analysiere die Vorschläge und implementiere die sinnvollen Verbesserungen direkt im Code.

Regeln:
- Implementiere nur Änderungen die tatsächlich die Code-Qualität verbessern
- Ignoriere rein kosmetische Vorschläge ohne Mehrwert
- Ignoriere Zusammenfassungen / Walkthroughs - fokussiere dich auf konkrete Änderungsvorschläge
- Bei Inline-Reviews: die Datei und Zeile stehen im Header

Gib am Ende eine kurze Zusammenfassung was du geändert hast.
"

  # Auto-commit & push
  if git diff --quiet && git diff --cached --quiet; then
    echo -e "${YELLOW}  Keine Änderungen von Claude — nichts zu committen.${NC}"
  else
    echo -e "${GREEN}  Änderungen erkannt, committe und pushe...${NC}"
    git add -A
    git commit -m "fix: apply CodeRabbit review suggestions for PR #${PR_NUMBER}

Automatisch verarbeitet von Claude Code.
Basierend auf ${COMMENT_COUNT} Kommentar(en) und ${INLINE_COUNT} Inline-Review(s)."
    git push origin "$PR_BRANCH"
    echo -e "${GREEN}  Gepusht auf '${PR_BRANCH}'.${NC}"
  fi

  echo ""
  PROCESSED=$((PROCESSED + 1))
done

# ─── Zurück zum ursprünglichen Branch ────────────────────────────
echo -e "${YELLOW}Wechsle zurück zu '${ORIGINAL_BRANCH}'...${NC}"
git checkout "$ORIGINAL_BRANCH" 2>/dev/null || true

# ─── Zusammenfassung ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Fertig! ${PROCESSED} PR(s) verarbeitet, ${SKIPPED} übersprungen.${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
