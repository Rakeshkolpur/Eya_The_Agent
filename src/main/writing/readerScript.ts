/**
 * The helper that reads the document being written. It is a small PowerShell program that stays running while Writing Watch is on and
 * answers one JSON line at a time (so each look costs a few milliseconds, not the second it takes to start PowerShell):
 *
 *   {"id":1,"cmd":"word"}                              Word, through its own automation interface: the paragraphs and where the cursor
 *                                                      is (all on this PC)
 *   {"id":5,"cmd":"spell","targets":[{"n":4,"head":"…"}]}  the words Word's spell checker doubts in those paragraphs, with its suggestions
 *                                                      (only if a paragraph still starts with the words that were read)
 *   {"id":2,"cmd":"focused"}                           the text box that has the keyboard, through Windows UI Automation — only in a
 *                                                      few plain editors (Notepad, WordPad, Notepad++, LibreOffice)
 *   {"id":3,"cmd":"replace","paragraph":5,"from":"…","to":"…","head":"…"}   one fix, in Word, that the user clicked
 *   {"id":4,"cmd":"quit"}
 *
 * It never reads a password box, a browser, or anything outside that short list, and it prints nothing but the answers. No backticks
 * and no dollar-braces are used so that the text can live in a JavaScript template.
 */
export const READER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$CR = [string][char]13
$LF = [string][char]10
$BEL = [string][char]7

function Out-Line($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

function Get-Word {
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') } catch { return $null }
}

function Read-Word {
  $app = Get-Word
  if ($null -eq $app) { return @{ found = $false; why = 'Word is not running' } }
  try {
    if ($app.Documents.Count -lt 1) { return @{ found = $false; why = 'no document is open' } }
    $doc = $app.ActiveDocument
    $name = [string]$doc.Name
    $count = [int]$doc.Paragraphs.Count
    $text = [string]$doc.Content.Text
    $parts = $text.Split([char]13)
    # Content.Text ends with the last paragraph mark, which leaves one empty piece at the end.
    $paras = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $parts.Length; $i++) {
      if ($i -eq $parts.Length - 1 -and $parts[$i] -eq '') { continue }
      $paras.Add($parts[$i].Replace($BEL, '').TrimEnd())
    }
    if ($paras.Count -ne $count) {
      # The text and Word disagree about where paragraphs end (tables): ask Word paragraph by paragraph.
      $paras.Clear()
      for ($i = 1; $i -le $count; $i++) { $paras.Add(([string]$doc.Paragraphs.Item($i).Range.Text).Replace($CR, '').Replace($BEL, '').TrimEnd()) }
    }
    $active = 0
    try {
      $start = [int]$app.Selection.Start
      if ($start -le 0) { $active = 1 }
      else {
        $before = $doc.Range(0, $start)
        $active = [int]$before.Paragraphs.Count
        $t = [string]$before.Text
        if ($t.Length -gt 0 -and $t[$t.Length - 1] -eq [char]13) { $active = $active + 1 }
      }
      if ($active -gt $count) { $active = $count }
    } catch { $active = 0 }
    return @{ found = $true; app = 'word'; title = $name; paragraphs = @($paras); active = $active }
  } catch {
    # Word is busy (a dialog is open, or it is saving): look again next time.
    return @{ found = $false; why = 'Word is busy' }
  }
}

# The few plain editors whose text box Eya may read when it has the keyboard. Word is read through its own interface, and a browser,
# a chat or a password box never.
$Allowed = @('notepad', 'wordpad', 'notepad++', 'soffice', 'soffice.bin', 'write')

# The words Word's own spell checker doubts in some paragraphs, with its suggestions. Asked for only when the writing has paused.
function Read-Spelling($targets) {
  $app = Get-Word
  if ($null -eq $app) { return @{ misspelled = @() } }
  $spelling = New-Object System.Collections.ArrayList
  try {
    $doc = $app.ActiveDocument
    $count = [int]$doc.Paragraphs.Count
    foreach ($t in $targets) {
      $p = [int]$t.n
      $head = [string]$t.head
      if ($p -lt 1 -or $p -gt $count) { continue }
      try {
        $range = $doc.Paragraphs.Item($p).Range
        # The paragraph must still start with the words that were read (the user may have kept typing): else it is skipped, not guessed.
        if ($head.Length -gt 0 -and -not ([string]$range.Text).StartsWith($head)) { continue }
        $n = 0
        foreach ($e in $range.SpellingErrors) {
          $n++
          if ($n -gt 10) { break }
          $word = [string]$e.Text
          $sugg = New-Object System.Collections.ArrayList
          try {
            foreach ($s in $app.GetSpellingSuggestions($word)) { [void]$sugg.Add([string]$s.Name); if ($sugg.Count -ge 3) { break } }
          } catch { }
          [void]$spelling.Add(@{ paragraph = $p; word = $word; suggestions = @($sugg) })
        }
      } catch { }
    }
  } catch { }
  return @{ misspelled = @($spelling) }
}

function Read-Focused {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { return @{ found = $false; why = 'nothing has the keyboard' } }
    if ($el.Current.IsPassword) { return @{ found = $false; why = 'a password box' } }
    $proc = Get-Process -Id $el.Current.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return @{ found = $false; why = 'unknown program' } }
    if ($Allowed -notcontains $proc.ProcessName.ToLowerInvariant()) { return @{ found = $false; why = 'not an editor Eya reads' } }
    $text = $null
    $active = 0
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
      $text = [string]$pat.DocumentRange.GetText(400000)
      try {
        $sel = $pat.GetSelection()
        if ($sel.Length -gt 0) {
          $r = $pat.DocumentRange.Clone()
          [void]$r.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $sel[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
          $before = [string]$r.GetText(-1)
          $active = ($before.Split([char]10)).Length
        }
      } catch { $active = 0 }
    } else {
      $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $text = [string]$vp.Current.Value }
    }
    if ($null -eq $text) { return @{ found = $false; why = 'no readable text' } }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in $text.Replace($CR + $LF, $LF).Replace($CR, $LF).Split([char]10)) { $lines.Add($line.TrimEnd()) }
    return @{ found = $true; app = 'other'; title = [string]$proc.MainWindowTitle; paragraphs = @($lines); active = $active; program = [string]$proc.ProcessName }
  } catch {
    return @{ found = $false; why = 'could not read' }
  }
}

function Escape-Find([string]$s) { return $s.Replace('^', '^^') }

function Replace-InWord([int]$paragraph, [string]$from, [string]$to, [string]$head) {
  $app = Get-Word
  if ($null -eq $app) { return @{ done = $false; why = 'Word is not running' } }
  try {
    $doc = $app.ActiveDocument
    if ($paragraph -lt 1 -or $paragraph -gt [int]$doc.Paragraphs.Count) { return @{ done = $false; why = 'no such paragraph' } }
    if ($from.Length -lt 1 -or $from.Length -gt 250) { return @{ done = $false; why = 'text too long to find' } }
    $range = $doc.Paragraphs.Item($paragraph).Range
    if ($head.Length -gt 0 -and -not ([string]$range.Text).StartsWith($head)) { return @{ done = $false; why = 'the paragraph has changed' } }
    $find = $range.Find
    $find.ClearFormatting()
    $find.Replacement.ClearFormatting()
    # Find(FindText, MatchCase, MatchWholeWord, MatchWildcards, MatchSoundsLike, MatchAllWordForms, Forward, Wrap, Format, ReplaceWith, Replace)
    $ok = $find.Execute((Escape-Find $from), $true, $false, $false, $false, $false, $true, 0, $false, (Escape-Find $to), 1)
    return @{ done = [bool]$ok }
  } catch {
    return @{ done = $false; why = 'Word would not make the change' }
  }
}

Out-Line @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $answer = $null
    switch ($req.cmd) {
      'word'    { $answer = Read-Word }
      'focused' { $answer = Read-Focused }
      'spell'   { $answer = Read-Spelling @($req.targets) }
      'replace' { $answer = Replace-InWord ([int]$req.paragraph) ([string]$req.from) ([string]$req.to) ([string]$req.head) }
      'quit'    { Out-Line @{ id = $id; bye = $true }; break }
      default   { $answer = @{ error = 'unknown command' } }
    }
    if ($req.cmd -eq 'quit') { break }
    $answer.id = $id
    Out-Line $answer
  } catch {
    Out-Line @{ id = $id; error = 'the helper could not answer' }
  }
}
`;
