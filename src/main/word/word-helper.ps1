# Eya's Word helper: a PowerShell program that stays running and answers one JSON line at a time, driving Microsoft Word through its own
# automation interface (all on this PC; nothing leaves it). Started by WordProcess.ts, which owns the protocol.
#
# Every change Eya makes is ONE undo step in Word ("Eya: ..." in the Undo list), so Ctrl+Z takes back what she just did.
# It works on the document in front (ActiveDocument), refuses a read-only or protected one, and never saves, closes or prints on its own.
#
# EYA_WORD_PRIVATE=1 (tests only): use a Word of its own, a separate hidden process, instead of the user's running Word. That is how the
# live tests stay away from anybody's real documents.
#
# Requests:  {"id":1,"cmd":"status"}  status | read | write | format | page_numbers | toc | table | index | header_footer | page_setup |
#            break | fields | replace | delete | undo | redo | save | goto | new | quit
# Answers:   {"id":1,"ok":true,...}  or  {"id":1,"ok":false,"why":"..."}

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$CR = [string][char]13
$LF = [string][char]10
$BEL = [string][char]7
$script:PrivateApp = $null

function Out-Line($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8)) }
function Has($o, [string]$name) { return ($null -ne $o) -and ($o.PSObject.Properties.Name -contains $name) -and ($null -ne $o.$name) }
function Fail([string]$why) { throw ('EYA:' + $why) }
function Clip([string]$s, [int]$n) { if ($s.Length -le $n) { return $s } else { return $s.Substring(0, $n) } }
function Escape-Find([string]$s) { return $s.Replace('^', '^^') }

# ------------------------------------------------------------------------------------------------------------------ Word itself
function Get-App([bool]$create) {
  if ($env:EYA_WORD_PRIVATE -eq '1') {
    if ($null -eq $script:PrivateApp -and $create) {
      $script:PrivateApp = New-Object -ComObject Word.Application
      $script:PrivateApp.Visible = $false
      $script:PrivateApp.DisplayAlerts = 0
    }
    return $script:PrivateApp
  }
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') } catch { }
  if ($create) {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $true
    return $app
  }
  return $null
}

function Need-App() {
  $app = Get-App $false
  if ($null -eq $app) { Fail 'Word is not open' }
  if ([int]$app.Documents.Count -lt 1) { Fail 'no document is open in Word' }
  return $app
}

function Need-Editable($doc) {
  if ([bool]$doc.ReadOnly) { Fail 'the document is read-only' }
  if ([int]$doc.ProtectionType -ne -1) { Fail 'the document is protected against editing' }
}

# Word is briefly "busy" while a dialog is open or it is saving: ask again a few times before giving up.
function Invoke-Retry([scriptblock]$block) {
  $tries = 0
  while ($true) {
    try { return (& $block) }
    catch {
      $hr = 0
      try { $hr = [int]$_.Exception.HResult } catch { }
      if ($hr -eq 0) { try { $hr = [int]$_.Exception.InnerException.HResult } catch { } }
      $busy = ($hr -eq -2147418111) -or ($hr -eq -2147417846)
      $tries++
      if ((-not $busy) -or ($tries -ge 6)) { throw }
      Start-Sleep -Milliseconds 400
    }
  }
}

# One undo step for everything a command does.
function With-Undo($app, [string]$label, [scriptblock]$body) {
  $custom = $false
  try { $app.UndoRecord.StartCustomRecord('Eya: ' + $label); $custom = $true } catch { }
  try { return (& $body) }
  finally { if ($custom) { try { $app.UndoRecord.EndCustomRecord() } catch { } } }
}

# ----------------------------------------------------------------------------------------------------------- names and values
$StyleIds = @{ 'normal' = -1; 'heading 1' = -2; 'heading 2' = -3; 'heading 3' = -4; 'heading 4' = -5; 'heading 5' = -6; 'title' = -63; 'subtitle' = -75;
  'list bullet' = -49; 'list number' = -50; 'body text' = -67; 'no spacing' = -158; 'quote' = -181 }
$ColorNames = @{ 'black' = 0; 'red' = 255; 'blue' = 16711680; 'green' = 32768; 'yellow' = 65535; 'orange' = 26367; 'purple' = 8388736;
  'gray' = 8421504; 'grey' = 8421504; 'white' = 16777215; 'darkblue' = 8388608; 'darkred' = 128 }
$HighlightNames = @{ 'none' = 0; 'yellow' = 7; 'green' = 4; 'turquoise' = 3; 'pink' = 5; 'blue' = 2; 'red' = 6; 'gray' = 15; 'grey' = 15; 'orange' = 7 }
$AlignNames = @{ 'left' = 0; 'center' = 1; 'centre' = 1; 'right' = 2; 'justify' = 3; 'justified' = 3 }

function Set-StyleOn($range, [string]$name) {
  $k = $name.Trim().ToLowerInvariant()
  if ($StyleIds.ContainsKey($k)) { $range.Style = [int]$StyleIds[$k] } else { $range.Style = $name }
}

function To-Bgr([string]$c) {
  $s = $c.Trim().ToLowerInvariant()
  if ($ColorNames.ContainsKey($s)) { return [int]$ColorNames[$s] }
  if ($s -match '^#?([0-9a-f]{6})$') {
    $h = $Matches[1]
    $r = [Convert]::ToInt32($h.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($h.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($h.Substring(4, 2), 16)
    return ($r + 256 * $g + 65536 * $b)
  }
  Fail ('I do not know the colour ' + $c)
}

# The text of the whole document in ONE call, as paragraphs (Word's own paragraph numbers: every paragraph mark ends one, a table's cell and
# row marks included). Asking Word about each paragraph separately costs ~40 ms a time, which is what made reading slow.
function Get-Paras($doc) {
  $parts = ([string]$doc.Content.Text).Split([char]13)
  $list = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $parts.Length; $i++) {
    if ($i -eq $parts.Length - 1 -and $parts[$i] -eq '') { continue }
    $list.Add($parts[$i].Replace($BEL, ''))
  }
  return , $list
}

# Which paragraph a position is in: the paragraph marks before it, counted in the text.
function Para-Number($doc, [int]$start) {
  if ($start -le 0) { return 1 }
  return ([string]$doc.Range(0, $start).Text).Split([char]13).Length
}

# Every place a piece of text occurs (as Word ranges), outside tables first when asked.
function Find-All($doc, [string]$text, [int]$limit, [bool]$matchCase) {
  $list = New-Object System.Collections.ArrayList
  if ($text.Length -lt 1 -or $text.Length -gt 250) { return , $list }
  $pos = 0
  $spin = 0
  $end = [int]$doc.Content.End
  $tocs = @()
  foreach ($t in $doc.TablesOfContents) { $tocs += , @([int]$t.Range.Start, [int]$t.Range.End) }
  while ($list.Count -lt $limit -and $pos -lt $end -and $spin -lt 3000) {
    $spin++
    # a fresh range each time: searching from inside a field (a contents entry) makes Word hand back the same text again
    $r = $doc.Range($pos, $end)
    $f = $r.Find
    $f.ClearFormatting()
    $ok = $f.Execute((Escape-Find $text), $matchCase, $false, $false, $false, $false, $true, 0, $false)
    if (-not $ok) { break }
    $hitStart = [int]$r.Start
    $hitEnd = [int]$r.End
    if ($hitStart -ge $pos) { [void]$list.Add($doc.Range($hitStart, $hitEnd)) }
    $pos = [Math]::Max($pos + 1, $hitEnd)
    # a hit in the contents list: go on after the whole list, not one character at a time inside it
    foreach ($t in $tocs) { if ($pos -ge $t[0] -and $pos -lt $t[1]) { $pos = $t[1] } }
  }
  return , $list
}

# The paragraph that is the heading / entry called `text`: one that starts with it (outside tables) if there is one, else one that contains it.
function In-Contents($doc, [int]$start) {
  foreach ($t in $doc.TablesOfContents) {
    if ($start -ge [int]$t.Range.Start -and $start -lt [int]$t.Range.End) { return $true }
  }
  return $false
}

function Find-Paragraph($doc, [string]$text, [bool]$headingOnly) {
  $all = Find-All $doc $text 80 $false
  $needle = $text.Trim().ToLowerInvariant()
  $startsHere = $null
  $fallback = $null
  foreach ($r in $all) {
    $p = $r.Paragraphs.Item(1).Range
    $inTable = $false
    try { $inTable = [bool]$p.Information(12) } catch { }
    # The contents list's closing mark sits at the very start of the paragraph after it, so test where the WORDS are, not the paragraph.
    if ($inTable -or (In-Contents $doc ([int]$r.Start))) { continue }
    $isHeading = $false
    try { $isHeading = ([int]$p.Paragraphs.Item(1).OutlineLevel -le 9) } catch { }
    $starts = ([string]$p.Text).Trim().ToLowerInvariant().StartsWith($needle)
    if ($isHeading -and $starts) { return $p }
    if ($headingOnly) { continue }
    if ($starts -and $null -eq $startsHere) { $startsHere = $p }
    if ($null -eq $fallback) { $fallback = $p }
  }
  if ($null -ne $startsHere) { return $startsHere }
  return $fallback
}

# What a target string means: selection | document | first | last | paragraph:N | paragraphs:A-B | heading:TEXT | containing:TEXT | find:TEXT | findall:TEXT
function Resolve-Target($app, $doc, [string]$target) {
  $t = $target.Trim()
  $ranges = New-Object System.Collections.ArrayList
  $note = ''
  $count = [int]$doc.Paragraphs.Count
  if ($t -eq '' -or $t -eq 'selection') {
    $r = $app.Selection.Range
    if ([int]$r.Start -eq [int]$r.End) { $r = $r.Paragraphs.Item(1).Range; $note = 'the paragraph the cursor is in' }
    [void]$ranges.Add($r)
  }
  elseif ($t -eq 'document') { [void]$ranges.Add($doc.Content) }
  elseif ($t -eq 'first') { [void]$ranges.Add($doc.Paragraphs.Item(1).Range) }
  elseif ($t -eq 'last') { [void]$ranges.Add($doc.Paragraphs.Item($count).Range) }
  elseif ($t -match '^paragraph:(\d+)$') {
    $n = [int]$Matches[1]
    if ($n -lt 1 -or $n -gt $count) { Fail ('there is no paragraph ' + $n + ' (the document has ' + $count + ')') }
    [void]$ranges.Add($doc.Paragraphs.Item($n).Range)
  }
  elseif ($t -match '^paragraphs:(\d+)-(\d+)$') {
    $a = [int]$Matches[1]; $b = [int]$Matches[2]
    if ($a -gt $b) { $x = $a; $a = $b; $b = $x }
    if ($a -lt 1 -or $b -gt $count) { Fail ('paragraphs ' + $a + ' to ' + $b + ' are not all there (the document has ' + $count + ')') }
    [void]$ranges.Add($doc.Range([int]$doc.Paragraphs.Item($a).Range.Start, [int]$doc.Paragraphs.Item($b).Range.End))
  }
  elseif ($t -match '^heading:(.+)$') {
    $p = Find-Paragraph $doc $Matches[1] $true
    if ($null -eq $p) { $p = Find-Paragraph $doc $Matches[1] $false; if ($null -ne $p) { $note = 'not a heading style, but the paragraph that starts with those words' } }
    if ($null -eq $p) { Fail ('I could not find a heading called "' + $Matches[1] + '"') }
    [void]$ranges.Add($p)
  }
  elseif ($t -match '^containing:(.+)$') {
    $all = Find-All $doc $Matches[1] 1 $false
    if ($all.Count -lt 1) { Fail ('I could not find "' + $Matches[1] + '" in the document') }
    [void]$ranges.Add($all[0].Paragraphs.Item(1).Range)
  }
  elseif ($t -match '^find:(.+)$') {
    $all = Find-All $doc $Matches[1] 1 $false
    if ($all.Count -lt 1) { Fail ('I could not find "' + $Matches[1] + '" in the document') }
    [void]$ranges.Add($all[0])
  }
  elseif ($t -match '^findall:(.+)$') {
    $all = Find-All $doc $Matches[1] 300 $false
    if ($all.Count -lt 1) { Fail ('I could not find "' + $Matches[1] + '" in the document') }
    foreach ($r in $all) { [void]$ranges.Add($r) }
  }
  else { Fail ('I do not understand the target "' + $t + '"') }
  return @{ ranges = $ranges; note = $note }
}

# ------------------------------------------------------------------------------------------------------------------ formatting
function Apply-Format($app, $range, $spec) {
  $applied = New-Object System.Collections.ArrayList
  if (Has $spec 'clear') {
    if ([bool]$spec.clear) { $range.ParagraphFormat.Reset(); $range.Font.Reset(); [void]$applied.Add('clear') }
  }
  if (Has $spec 'style') {
    Set-StyleOn $range ([string]$spec.style)
    $range.ParagraphFormat.Reset()
    $range.Font.Reset()
    [void]$applied.Add('style')
  }
  $font = $range.Font
  if (Has $spec 'bold') { $font.Bold = $(if ([bool]$spec.bold) { -1 } else { 0 }); [void]$applied.Add('bold') }
  if (Has $spec 'italic') { $font.Italic = $(if ([bool]$spec.italic) { -1 } else { 0 }); [void]$applied.Add('italic') }
  if (Has $spec 'underline') { $font.Underline = $(if ([bool]$spec.underline) { 1 } else { 0 }); [void]$applied.Add('underline') }
  if (Has $spec 'strike') { $font.StrikeThrough = $(if ([bool]$spec.strike) { -1 } else { 0 }); [void]$applied.Add('strike') }
  if (Has $spec 'allCaps') { $font.AllCaps = $(if ([bool]$spec.allCaps) { -1 } else { 0 }); [void]$applied.Add('allCaps') }
  if (Has $spec 'smallCaps') { $font.SmallCaps = $(if ([bool]$spec.smallCaps) { -1 } else { 0 }); [void]$applied.Add('smallCaps') }
  if (Has $spec 'fontName') { $font.Name = [string]$spec.fontName; [void]$applied.Add('fontName') }
  if (Has $spec 'fontSize') {
    $size = [double]$spec.fontSize
    if ($size -lt 1 -or $size -gt 400) { Fail 'that font size is not possible' }
    $font.Size = $size; [void]$applied.Add('fontSize')
  }
  if (Has $spec 'color') { $font.Color = (To-Bgr ([string]$spec.color)); [void]$applied.Add('color') }
  if (Has $spec 'highlight') {
    $h = ([string]$spec.highlight).Trim().ToLowerInvariant()
    if (-not $HighlightNames.ContainsKey($h)) { Fail ('I do not know the highlight colour ' + $h) }
    $range.HighlightColorIndex = [int]$HighlightNames[$h]; [void]$applied.Add('highlight')
  }
  $pf = $range.ParagraphFormat
  if (Has $spec 'align') {
    $a = ([string]$spec.align).Trim().ToLowerInvariant()
    if (-not $AlignNames.ContainsKey($a)) { Fail ('alignment must be left, center, right or justify, not ' + $a) }
    $pf.Alignment = [int]$AlignNames[$a]; [void]$applied.Add('align')
  }
  if (Has $spec 'lineSpacing') {
    $ls = [double]$spec.lineSpacing
    if ($ls -lt 0.5 -or $ls -gt 5) { Fail 'line spacing must be between 0.5 and 5' }
    if ($ls -eq 1) { $pf.LineSpacingRule = 0 }
    elseif ($ls -eq 1.5) { $pf.LineSpacingRule = 1 }
    elseif ($ls -eq 2) { $pf.LineSpacingRule = 2 }
    else { $pf.LineSpacingRule = 5; $pf.LineSpacing = $app.LinesToPoints($ls) }
    [void]$applied.Add('lineSpacing')
  }
  if (Has $spec 'spaceBefore') { $pf.SpaceBefore = [double]$spec.spaceBefore; [void]$applied.Add('spaceBefore') }
  if (Has $spec 'spaceAfter') { $pf.SpaceAfter = [double]$spec.spaceAfter; [void]$applied.Add('spaceAfter') }
  if (Has $spec 'leftIndentCm') { $pf.LeftIndent = $app.CentimetersToPoints([double]$spec.leftIndentCm); [void]$applied.Add('leftIndent') }
  if (Has $spec 'rightIndentCm') { $pf.RightIndent = $app.CentimetersToPoints([double]$spec.rightIndentCm); [void]$applied.Add('rightIndent') }
  if (Has $spec 'firstLineIndentCm') { $pf.FirstLineIndent = $app.CentimetersToPoints([double]$spec.firstLineIndentCm); [void]$applied.Add('firstLineIndent') }
  if (Has $spec 'keepWithNext') { $pf.KeepWithNext = $(if ([bool]$spec.keepWithNext) { -1 } else { 0 }); [void]$applied.Add('keepWithNext') }
  if (Has $spec 'pageBreakBefore') { $pf.PageBreakBefore = $(if ([bool]$spec.pageBreakBefore) { -1 } else { 0 }); [void]$applied.Add('pageBreakBefore') }
  if (Has $spec 'list') {
    $l = ([string]$spec.list).Trim().ToLowerInvariant()
    if ($l -eq 'bullets') { $range.ListFormat.ApplyBulletDefault() }
    elseif ($l -eq 'numbers') { $range.ListFormat.ApplyNumberDefault() }
    elseif ($l -eq 'none') { $range.ListFormat.RemoveNumbers() }
    else { Fail 'list must be bullets, numbers or none' }
    [void]$applied.Add('list')
  }
  return , $applied
}

# ------------------------------------------------------------------------------------------------------------ where to put things
# The empty paragraph made for a block has to be plain text: left alone it is a copy of the paragraph next to it, a heading's style included.
function Plain-Point($doc, [int]$pos) {
  $pt = $doc.Range($pos, $pos)
  try {
    $pr = $pt.Paragraphs.Item(1).Range
    if (([string]$pr.Text).TrimEnd($CR).Length -eq 0) {
      $pr.Style = -1
      $pr.ParagraphFormat.Reset()
      $pr.Font.Reset()
    }
  } catch { }
  return $doc.Range($pos, $pos)
}

# A collapsed range where a new BLOCK (a table, a contents list, a break) can go, in a paragraph of its own.
function Get-BlockPoint($app, $doc, [string]$at) {
  $a = $at.Trim()
  if ($a -eq '') { $a = 'cursor' }
  if ($a -eq 'cursor') {
    $r = $app.Selection.Range
    $r.Collapse(0)
    $para = $r.Paragraphs.Item(1).Range
    $text = ([string]$para.Text).TrimEnd($CR)
    if ($text.Length -eq 0) { return (Plain-Point $doc ([int]$para.Start)) }
    $pos = [int]$r.Start
    $r.InsertAfter($CR)
    return (Plain-Point $doc ($pos + 1))
  }
  if ($a -eq 'start') {
    $first = $doc.Paragraphs.Item(1).Range
    $s = [int]$first.Start
    $doc.Range($s, $s).InsertBefore($CR)
    return (Plain-Point $doc $s)
  }
  if ($a -eq 'end') {
    $last = $doc.Paragraphs.Item([int]$doc.Paragraphs.Count).Range
    $text = ([string]$last.Text).TrimEnd($CR)
    if ($text.Length -eq 0) { return (Plain-Point $doc ([int]$last.Start)) }
    $pos = [int]$last.End - 1
    $doc.Range($pos, $pos).InsertAfter($CR)
    return (Plain-Point $doc ($pos + 1))
  }
  if ($a -match '^(after|before):(.+)$') {
    $where = $Matches[1]; $tg = $Matches[2]
    $res = Resolve-Target $app $doc $tg
    $anchor = $res.ranges[0].Paragraphs.Item(1).Range
    # A block cannot go inside a table's cell: next to a cell it goes before or after the whole table.
    $inCell = $false
    try { $inCell = [bool]$anchor.Information(12) } catch { }
    if ($inCell) {
      $tbl = $anchor.Tables.Item(1)
      if ($where -eq 'after') {
        $pos = [int]$tbl.Range.End
        $doc.Range($pos, $pos).InsertBefore($CR)
        return (Plain-Point $doc $pos)
      }
      $ts = [int]$tbl.Range.Start
      if ($ts -gt 0) {
        # before the table = after the paragraph in front of it
        $pos = $ts - 1
        $doc.Range($pos, $pos).InsertAfter($CR)
        return (Plain-Point $doc ($pos + 1))
      }
      Fail 'that table is at the very start of the document, so nothing can go in front of it from here'
    }
    if ($where -eq 'after') {
      $lastPara = $res.ranges[$res.ranges.Count - 1]
      $lastPara = $lastPara.Paragraphs.Item([int]$lastPara.Paragraphs.Count).Range
      $pos = [int]$lastPara.End - 1
      $doc.Range($pos, $pos).InsertAfter($CR)
      return (Plain-Point $doc ($pos + 1))
    }
    $s = [int]$anchor.Start
    $doc.Range($s, $s).InsertBefore($CR)
    return (Plain-Point $doc $s)
  }
  Fail ('I do not understand the place "' + $a + '" (use cursor, start, end, after:<target> or before:<target>)')
}

# ------------------------------------------------------------------------------------------------------------------- the commands
function Cmd-Status($req) {
  $app = Get-App $false
  if ($null -eq $app) { return @{ ok = $true; found = $false; why = 'Word is not open' } }
  if ([int]$app.Documents.Count -lt 1) { return @{ ok = $true; found = $false; why = 'Word is open but no document is' } }
  $doc = $app.ActiveDocument
  $paras = Get-Paras $doc
  $info = [ordered]@{ ok = $true; found = $true }
  $info.name = [string]$doc.Name
  $info.path = [string]$doc.Path
  $info.saved = [bool]$doc.Saved
  $info.readOnly = [bool]$doc.ReadOnly
  $info.protected = ([int]$doc.ProtectionType -ne -1)
  $info.paragraphs = [int]$paras.Count
  $info.pages = [int]$doc.ComputeStatistics(2)
  $info.words = [int]$doc.ComputeStatistics(0)
  $info.sections = [int]$doc.Sections.Count
  $info.tables = [int]$doc.Tables.Count
  $info.tablesOfContents = [int]$doc.TablesOfContents.Count
  $info.trackChanges = [bool]$doc.TrackRevisions
  $others = New-Object System.Collections.ArrayList
  foreach ($d in $app.Documents) { if ([string]$d.Name -ne $info.name) { [void]$others.Add([string]$d.Name) } }
  $info.otherDocuments = @($others)
  $selStart = [int]$app.Selection.Start
  $at = Para-Number $doc $selStart
  if ($at -gt $paras.Count) { $at = $paras.Count }
  $cursor = @{ paragraph = $at; hasSelection = ([int]$app.Selection.End -gt $selStart) }
  if ($at -ge 1 -and $at -le $paras.Count) { $cursor.text = Clip ($paras[$at - 1]).Trim() 80 }
  try { $cursor.page = [int]$app.Selection.Information(3) } catch { }
  $info.cursor = $cursor
  try {
    $sec = $doc.Sections.Item(1)
    $info.header = Clip ([string]$sec.Headers.Item(1).Range.Text).Trim() 100
    $info.footer = Clip ([string]$sec.Footers.Item(1).Range.Text).Trim() 100
    $pn = 0
    foreach ($f in $sec.Footers.Item(1).Range.Fields) { if ([int]$f.Type -eq 33) { $pn++ } }
    foreach ($f in $sec.Headers.Item(1).Range.Fields) { if ([int]$f.Type -eq 33) { $pn++ } }
    $info.pageNumbers = ($pn -gt 0)
    $info.differentFirstPage = [bool]$sec.PageSetup.DifferentFirstPageHeaderFooter
  } catch { }
  # The headings in one call (Word's own list of them), then each one's paragraph number found in the text we already have.
  $headings = New-Object System.Collections.ArrayList
  $truncated = $false
  try {
    $items = @($doc.GetCrossReferenceItems(1))
    $from = 0
    foreach ($item in $items) {
      $raw = [string]$item
      $level = 1 + ($raw.Length - $raw.TrimStart().Length)
      $label = $raw.Trim()
      if ($label.Length -eq 0) { continue }
      if ($headings.Count -ge 60) { $truncated = $true; break }
      # Its paragraph, from the text we already have: the same words in the same case, in order. Where the words repeat (a table of
      # contents line, an index cell) the one that really is a heading is taken, which costs one Word call per candidate.
      $candidates = New-Object System.Collections.ArrayList
      for ($i = $from; $i -lt $paras.Count -and $candidates.Count -lt 5; $i++) {
        if ($paras[$i].Trim() -ceq $label) { [void]$candidates.Add($i) }
      }
      $n = 0
      if ($candidates.Count -eq 1) { $n = [int]$candidates[0] + 1 }
      elseif ($candidates.Count -gt 1) {
        $n = [int]$candidates[0] + 1
        foreach ($c in $candidates) {
          $isHead = $false
          try { $isHead = ([int]$doc.Paragraphs.Item([int]$c + 1).OutlineLevel -le 9) } catch { }
          if ($isHead) { $n = [int]$c + 1; break }
        }
      }
      if ($n -gt 0) { $from = $n }
      $row = @{ level = $level; text = (Clip $label 70) }
      if ($n -gt 0) { $row.n = $n }
      [void]$headings.Add($row)
    }
  } catch { }
  # A page for each heading is one Word call each: only for a short list.
  if ($headings.Count -gt 0 -and $headings.Count -le 8) {
    foreach ($h in $headings) {
      if ($h.ContainsKey('n')) {
        try { $h.page = [int]$doc.Paragraphs.Item([int]$h.n).Range.Information(3) } catch { }
      }
    }
  }
  $info.headings = @($headings)
  $info.headingsTruncated = $truncated
  return $info
}

function Cmd-Read($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  $paras = Get-Paras $doc
  $count = [int]$paras.Count

  # find: where a piece of text is, in one go (a placeholder like "P1", a name, a clause number)
  if (Has $req 'find') {
    $needle = ([string]$req.find).Trim()
    if ($needle.Length -lt 1) { Fail 'there is nothing to look for' }
    $cs = (Has $req 'matchCase') -and [bool]$req.matchCase
    $cmp = $(if ($cs) { [StringComparison]::Ordinal } else { [StringComparison]::OrdinalIgnoreCase })
    $matches2 = New-Object System.Collections.ArrayList
    $total = 0
    for ($i = 0; $i -lt $count; $i++) {
      $at = $paras[$i].IndexOf($needle, $cmp)
      if ($at -lt 0) { continue }
      $total++
      if ($matches2.Count -ge 25) { continue }
      $s0 = [Math]::Max(0, $at - 70)
      $len = [Math]::Min($paras[$i].Length - $s0, 70 + $needle.Length + 70)
      [void]$matches2.Add(@{ n = ($i + 1); text = ($paras[$i].Substring($s0, $len)) })
    }
    # which page each of the first few is on (a page needs Word's layout, so only for a few)
    if ($matches2.Count -gt 0 -and $matches2.Count -le 8) {
      foreach ($m in $matches2) {
        try { $m.page = [int]$doc.Paragraphs.Item([int]$m.n).Range.Information(3) } catch { }
      }
    }
    return @{ ok = $true; find = $needle; total = $total; paragraphsInDocument = $count; matches = @($matches2) }
  }

  $maxParas = 120
  $from = 1; $to = $count
  if (Has $req 'last') { $from = [Math]::Max(1, $count - [int]$req.last + 1) }
  else {
    if (Has $req 'from') { $from = [Math]::Max(1, [int]$req.from) }
    if (Has $req 'to') { $to = [Math]::Min($count, [int]$req.to) }
    elseif (Has $req 'from') { $to = [Math]::Min($count, $from + 29) }
    else { $c = [Math]::Min($count, (Para-Number $doc ([int]$app.Selection.Start))); $from = [Math]::Max(1, $c - 3); $to = [Math]::Min($count, $c + 12) }
  }
  if ($to - $from + 1 -gt $maxParas) { $to = $from + $maxParas - 1 }
  $detail = (Has $req 'detail') -and [bool]$req.detail
  $out = New-Object System.Collections.ArrayList
  for ($i = $from; $i -le $to; $i++) {
    $text = $paras[$i - 1]
    $row = [ordered]@{ n = $i; text = (Clip $text 400) }
    if ($text.Length -gt 400) { $row.length = $text.Length }
    [void]$out.Add($row)
  }
  # how it looks is asked of Word paragraph by paragraph (slow), so only when asked for, and for a few
  if ($detail) {
    $k = 0
    foreach ($row in $out) {
      $k++
      if ($k -gt 10) { break }
      $p = $doc.Paragraphs.Item([int]$row.n)
      $r = $p.Range
      try { $row.style = [string]$p.Style.NameLocal } catch { }
      try { $row.align = @('left', 'center', 'right', 'justify')[[int]$p.Alignment] } catch { }
      try { $b = [int]$r.Font.Bold; if ($b -eq -1 -or $b -eq 1) { $row.bold = $true } elseif ($b -eq 0) { $row.bold = $false } else { $row.bold = 'mixed' } } catch { }
      try { $row.size = [double]$r.Font.Size } catch { }
      try { $row.font = [string]$r.Font.Name } catch { }
      try { if ([int]$r.ListFormat.ListType -ne 0) { $row.list = [string]$r.ListFormat.ListString } } catch { }
      try { if ([bool]$r.Information(12)) { $row.inTable = $true } } catch { }
    }
  }
  return @{ ok = $true; from = $from; to = $to; total = $count; paragraphs = @($out); more = ($to -lt $count) }
}

function Cmd-Write($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $text = [string]$req.text
  if ($text.Length -eq 0) { Fail 'there is no text to write' }
  if ($text.Length -gt 60000) { Fail 'that is too much text for one go' }
  $text = $text.Replace($CR + $LF, $CR).Replace($LF, $CR)
  $at = 'cursor'
  if (Has $req 'at') { $at = ([string]$req.at).Trim() }
  $newPara = $true
  if (Has $req 'newParagraph') { $newPara = [bool]$req.newParagraph }
  $styleGiven = (Has $req 'style')
  $state = @{}
  $range = With-Undo $app 'write' {
    $inserted = $null
    $afterHeading = $false
    $afterPara = $null
    if ($at -eq 'cursor' -or $at -eq 'replace_selection') {
      $sel = $app.Selection
      $r = $sel.Range
      if ($at -eq 'replace_selection' -and [int]$r.End -gt [int]$r.Start) {
        $s = [int]$r.Start
        $r.Text = $text
        $inserted = $doc.Range($s, $s + $text.Length)
      } else {
        $r.Collapse(0)
        $prefix = ''
        if ($newPara) {
          $para = $r.Paragraphs.Item(1).Range
          $ptext = ([string]$para.Text).TrimEnd($CR)
          if ($ptext.Length -gt 0 -and [int]$r.Start -ge ([int]$para.End - 1)) { $prefix = $CR; $afterPara = $para }
        }
        $s = [int]$r.Start
        $r.InsertAfter($prefix + $text)
        $inserted = $doc.Range($s + $prefix.Length, $s + $prefix.Length + $text.Length)
      }
      $app.Selection.SetRange([int]$inserted.End, [int]$inserted.End)
    }
    elseif ($at -eq 'end') {
      $last = $doc.Paragraphs.Item([int]$doc.Paragraphs.Count).Range
      $ptext = ([string]$last.Text).TrimEnd($CR)
      $pos = [int]$last.End - 1
      $prefix = ''
      if ($ptext.Length -gt 0) { $prefix = $CR; $afterPara = $last }
      $doc.Range($pos, $pos).InsertAfter($prefix + $text)
      $inserted = $doc.Range($pos + $prefix.Length, $pos + $prefix.Length + $text.Length)
    }
    elseif ($at -eq 'start') {
      $first = $doc.Paragraphs.Item(1).Range
      $s = [int]$first.Start
      $doc.Range($s, $s).InsertBefore($text + $CR)
      $inserted = $doc.Range($s, $s + $text.Length)
    }
    elseif ($at -match '^(after|before):(.+)$') {
      $where = $Matches[1]
      $res = Resolve-Target $app $doc $Matches[2]
      if ($where -eq 'after') {
        $anchor = $res.ranges[$res.ranges.Count - 1]
        $anchor = $anchor.Paragraphs.Item([int]$anchor.Paragraphs.Count).Range
        $afterPara = $anchor
        $pos = [int]$anchor.End - 1
        $doc.Range($pos, $pos).InsertAfter($CR + $text)
        $inserted = $doc.Range($pos + 1, $pos + 1 + $text.Length)
      } else {
        $anchor = $res.ranges[0].Paragraphs.Item(1).Range
        try { $afterHeading = ([int]$anchor.Paragraphs.Item(1).OutlineLevel -le 9) } catch { }
        $s = [int]$anchor.Start
        $doc.Range($s, $s).InsertBefore($text + $CR)
        $inserted = $doc.Range($s, $s + $text.Length)
      }
    }
    else { Fail ('I do not understand the place "' + $at + '" (use cursor, start, end, after:<target>, before:<target> or replace_selection)') }
    # A new paragraph takes on what pressing Enter would give: the next-paragraph style of the one before (a heading is followed by plain
    # text), unless a style was asked for. Text put before a heading is plain text, not another heading.
    if (-not $styleGiven) {
      if ($null -ne $afterPara) {
        try {
          $prevStyle = $afterPara.Paragraphs.Item(1).Style
          $nextStyle = $prevStyle.NextParagraphStyle
          if ($null -ne $nextStyle -and [string]$nextStyle.NameLocal -ne [string]$prevStyle.NameLocal) {
            $inserted.Style = $nextStyle
            $inserted.Font.Reset()
            $inserted.ParagraphFormat.Reset()
          }
        } catch { }
      }
      elseif ($afterHeading) { $inserted.Style = -1; $inserted.Font.Reset(); $inserted.ParagraphFormat.Reset() }
    }
    $fmt = Apply-Format $app $inserted $req
    $state.applied = @($fmt)
    return $inserted
  }
  $from = Para-Number $doc ([int]$range.Start)
  $to = Para-Number $doc ([Math]::Max([int]$range.Start, [int]$range.End - 1))
  return @{ ok = $true; written = $text.Length; paragraphs = @{ from = $from; to = $to }; formatted = $state.applied }
}

function Cmd-Format($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $target = 'selection'
  if (Has $req 'target') { $target = [string]$req.target }
  $res = Resolve-Target $app $doc $target
  $state = @{ applied = @() }
  [void](With-Undo $app 'format' {
    foreach ($r in $res.ranges) {
      $a = Apply-Format $app $r $req
      $state.applied = @($a)
    }
  })
  if ($state.applied.Count -eq 0) { Fail 'nothing to change was given (bold, italic, size, alignment, style...)' }
  $first = $res.ranges[0]
  return @{ ok = $true; applied = $state.applied; places = [int]$res.ranges.Count; note = $res.note
    paragraphs = @{ from = (Para-Number $doc ([int]$first.Start)) } }
}

function Set-HeaderFooterParts($doc, $hf, [string]$template, [string]$align) {
  # {PAGE} and {NUMPAGES} become live page-number fields; everything else is plain text.
  $r = $hf.Range
  $r.Text = $template.Replace('{PAGE}', '[[EYAPAGE]]').Replace('{NUMPAGES}', '[[EYAPAGES]]')
  foreach ($pair in @(@('[[EYAPAGE]]', 33), @('[[EYAPAGES]]', 26))) {
    $guard = 0
    while ($guard -lt 5) {
      $guard++
      $rr = $hf.Range
      $f = $rr.Find
      $f.ClearFormatting()
      if (-not $f.Execute($pair[0], $true, $false, $false, $false, $false, $true, 0, $false)) { break }
      [void]$doc.Fields.Add($rr, [int]$pair[1])
    }
  }
  if ($align -ne '') {
    $a = $align.Trim().ToLowerInvariant()
    if ($AlignNames.ContainsKey($a)) { $hf.Range.ParagraphFormat.Alignment = [int]$AlignNames[$a] }
  }
}

function Cmd-PageNumbers($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $where = 'footer'
  if (Has $req 'where') { $where = ([string]$req.where).ToLowerInvariant() }
  $remove = (Has $req 'remove') -and [bool]$req.remove
  $format = 'number'
  if (Has $req 'format') { $format = ([string]$req.format).ToLowerInvariant() }
  $align = 'center'
  if (Has $req 'align') { $align = [string]$req.align }
  $templates = @{ 'number' = '{PAGE}'; 'page_n' = 'Page {PAGE}'; 'page_n_of_m' = 'Page {PAGE} of {NUMPAGES}'; 'n_of_m' = '{PAGE} of {NUMPAGES}'; 'dash' = '- {PAGE} -' }
  if (-not $templates.ContainsKey($format)) { Fail 'format must be number, page_n, page_n_of_m, n_of_m or dash' }
  $state = @{ done = 0 }
  [void](With-Undo $app 'page numbers' {
    $i = 0
    foreach ($sec in $doc.Sections) {
      $i++
      $hf = $(if ($where -eq 'header') { $sec.Headers.Item(1) } else { $sec.Footers.Item(1) })
      if ($i -gt 1 -and [bool]$hf.LinkToPrevious) { continue }
      if ($remove) {
        foreach ($f in @($hf.Range.Fields)) { if ([int]$f.Type -eq 33 -or [int]$f.Type -eq 26) { $f.Delete() } }
        # a footer that held only the number is left empty, not with "Page  of"
        $left = ([string]$hf.Range.Text).Trim()
        if ($left -match '^(Page|of|-|\s)*$') { $hf.Range.Text = '' }
      } else {
        # the number goes on its own line when the footer already says something else (a case number, say)
        $existing = ([string]$hf.Range.Text).Trim()
        $hasField = $false
        foreach ($f in $hf.Range.Fields) { if ([int]$f.Type -eq 33) { $hasField = $true } }
        if ($existing.Length -gt 0 -and -not $hasField) {
          $hf.Range.InsertAfter($CR + $templates[$format].Replace('{PAGE}', '[[EYAPAGE]]').Replace('{NUMPAGES}', '[[EYAPAGES]]'))
          foreach ($pair in @(@('[[EYAPAGE]]', 33), @('[[EYAPAGES]]', 26))) {
            $rr = $hf.Range
            $ff = $rr.Find
            $ff.ClearFormatting()
            if ($ff.Execute($pair[0], $true, $false, $false, $false, $false, $true, 0, $false)) { [void]$doc.Fields.Add($rr, [int]$pair[1]) }
          }
          $hf.Range.Paragraphs.Item([int]$hf.Range.Paragraphs.Count).Range.ParagraphFormat.Alignment = $(if ($AlignNames.ContainsKey($align.ToLowerInvariant())) { [int]$AlignNames[$align.ToLowerInvariant()] } else { 1 })
        } else {
          Set-HeaderFooterParts $doc $hf $templates[$format] $align
        }
        if (Has $req 'startAt') {
          $hf.PageNumbers.RestartNumberingAtSection = $true
          $hf.PageNumbers.StartingNumber = [int]$req.startAt
        }
      }
      if (Has $req 'skipFirstPage') { $sec.PageSetup.DifferentFirstPageHeaderFooter = $(if ([bool]$req.skipFirstPage) { -1 } else { 0 }) }
      $state.done++
    }
    $doc.Repaginate()
  })
  return @{ ok = $true; removed = $remove; where = $where; format = $format; sections = $state.done; pages = [int]$doc.ComputeStatistics(2) }
}

function Cmd-Toc($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $levels = 3
  if (Has $req 'levels') { $levels = [Math]::Min(9, [Math]::Max(1, [int]$req.levels)) }
  $headingCount = 0
  foreach ($p in $doc.Paragraphs) { try { if ([int]$p.OutlineLevel -le $levels) { $headingCount++ } } catch { } }
  if ((Has $req 'remove') -and [bool]$req.remove) {
    $n = [int]$doc.TablesOfContents.Count
    [void](With-Undo $app 'remove contents' { foreach ($t in @($doc.TablesOfContents)) { $t.Delete() } })
    return @{ ok = $true; removed = $n }
  }
  if ($doc.TablesOfContents.Count -gt 0 -and -not ((Has $req 'replace') -and [bool]$req.replace)) {
    [void](With-Undo $app 'update contents' { foreach ($t in $doc.TablesOfContents) { $t.Update() } })
    return @{ ok = $true; updated = $true; headings = $headingCount; pages = [int]$doc.ComputeStatistics(2) }
  }
  if ($headingCount -lt 1) { Fail 'the document has no headings yet, so a table of contents would be empty (mark the headings first, e.g. style Heading 1)' }
  $at = 'cursor'
  if (Has $req 'at') { $at = [string]$req.at }
  [void](With-Undo $app 'table of contents' {
    if ($doc.TablesOfContents.Count -gt 0) { foreach ($t in @($doc.TablesOfContents)) { $t.Delete() } }
    $point = Get-BlockPoint $app $doc $at
    $start = [int]$point.Start
    if (Has $req 'title') {
      $point.InsertAfter([string]$req.title + $CR)
      $titleRange = $doc.Range($start, $start + ([string]$req.title).Length)
      $titleRange.Style = -1
      $titleRange.Font.Bold = -1
      $titleRange.ParagraphFormat.Alignment = 1
      $point = $doc.Range($start + ([string]$req.title).Length + 1, $start + ([string]$req.title).Length + 1)
    }
    [void]$doc.TablesOfContents.Add($point, $true, 1, $levels, $false, [Type]::Missing, $true, $true, [Type]::Missing, $true)
    $doc.Repaginate()
    foreach ($t in $doc.TablesOfContents) { $t.Update() }
  })
  return @{ ok = $true; created = $true; headings = $headingCount; levels = $levels; pages = [int]$doc.ComputeStatistics(2) }
}

function Looks-Like-SerialHeader([string]$s) { return ($s.Trim().ToLowerInvariant() -match '^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|serial|no\.?)$') }

function Style-Table($app, $table, [double[]]$widths) {
  $table.Borders.Enable = $true
  $pf = $table.Range.ParagraphFormat
  $pf.Alignment = 0
  $pf.FirstLineIndent = 0
  $pf.LeftIndent = 0
  $pf.SpaceBefore = 3
  $pf.SpaceAfter = 3
  $pf.LineSpacingRule = 0
  $table.AutoFitBehavior(2)
  if ($null -ne $widths -and $widths.Length -eq [int]$table.Columns.Count) {
    for ($c = 1; $c -le $widths.Length; $c++) {
      $col = $table.Columns.Item($c)
      $col.PreferredWidthType = 2
      $col.PreferredWidth = $widths[$c - 1]
    }
  }
}

function Cmd-Table($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $rows = New-Object System.Collections.ArrayList
  foreach ($row in @($req.rows)) {
    $cells = New-Object System.Collections.ArrayList
    foreach ($c in @($row)) { [void]$cells.Add(([string]$c).Replace($CR, ' ').Replace($LF, ' ').Replace("`t", ' ')) }
    [void]$rows.Add($cells)
  }
  if ($rows.Count -lt 1) { Fail 'there are no rows to put in a table' }
  if ($rows.Count -gt 300) { Fail 'that is too many rows for one go' }
  $append = (Has $req 'append') -and [bool]$req.append
  $header = $true
  if (Has $req 'header') { $header = [bool]$req.header }
  $autoNumber = $true
  if (Has $req 'autoNumber') { $autoNumber = [bool]$req.autoNumber }
  $widths = $null
  if (Has $req 'widths') { $widths = [double[]]@($req.widths) }
  $state = @{ rows = 0; tableIndex = 0 }

  if ($append) {
    $count = [int]$doc.Tables.Count
    if ($count -lt 1) { Fail 'the document has no table to add rows to' }
    $ti = $count
    if (Has $req 'tableIndex') { $ti = [int]$req.tableIndex }
    if ($ti -lt 1 -or $ti -gt $count) { Fail ('there is no table ' + $ti + ' (the document has ' + $count + ')') }
    $table = $doc.Tables.Item($ti)
    $cols = [int]$table.Columns.Count
    [void](With-Undo $app 'add rows' {
      $serialColumn = Looks-Like-SerialHeader ([string]$table.Cell(1, 1).Range.Text).TrimEnd([char]13, [char]7)
      foreach ($cells in $rows) {
        $newRow = $table.Rows.Add()
        $values = New-Object System.Collections.ArrayList
        if ($autoNumber -and $serialColumn -and $cells.Count -eq $cols - 1) {
          [void]$values.Add([string]([int]$table.Rows.Count - 1))
        }
        foreach ($c in $cells) { [void]$values.Add($c) }
        $r = [int]$table.Rows.Count
        for ($c = 1; $c -le [Math]::Min($cols, $values.Count); $c++) { $table.Cell($r, $c).Range.Text = [string]$values[$c - 1] }
        $state.rows++
      }
    })
    $state.tableIndex = $ti
  } else {
    $cols = 0
    foreach ($cells in $rows) { if ($cells.Count -gt $cols) { $cols = $cells.Count } }
    if ($cols -lt 1 -or $cols -gt 12) { Fail 'a table needs between 1 and 12 columns' }
    $at = 'cursor'
    if (Has $req 'at') { $at = [string]$req.at }
    $table = $null
    [void](With-Undo $app 'table' {
      $point = Get-BlockPoint $app $doc $at
      if (Has $req 'title') {
        $start = [int]$point.Start
        $point.InsertAfter([string]$req.title + $CR)
        $tr = $doc.Range($start, $start + ([string]$req.title).Length)
        $tr.Style = -1
        $tr.Font.Bold = -1
        $tr.ParagraphFormat.Alignment = 1
        $point = $doc.Range($start + ([string]$req.title).Length + 1, $start + ([string]$req.title).Length + 1)
      }
      $t = $doc.Tables.Add($point, $rows.Count, $cols)
      for ($r = 1; $r -le $rows.Count; $r++) {
        $cells = $rows[$r - 1]
        for ($c = 1; $c -le [Math]::Min($cols, $cells.Count); $c++) { $t.Cell($r, $c).Range.Text = [string]$cells[$c - 1] }
      }
      Style-Table $app $t $widths
      if ($header) {
        $t.Rows.Item(1).Range.Font.Bold = -1
        $t.Rows.Item(1).HeadingFormat = -1
        $t.Rows.Item(1).Range.ParagraphFormat.Alignment = 1
      }
      $state.rows = $rows.Count
      $state.tableIndex = [int]$doc.Range(0, [int]$t.Range.End).Tables.Count
    })
  }
  return @{ ok = $true; rows = $state.rows; tableIndex = $state.tableIndex; appended = $append; pages = [int]$doc.ComputeStatistics(2) }
}

# A running index: a table of S.No / Particulars / Page, where the page is a live field pointing at the entry in the document, so the
# numbers follow the document as it grows (Word refreshes them when it paginates or prints; "update_fields" does it on demand).
function Cmd-Index($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $entries = New-Object System.Collections.ArrayList
  foreach ($e in @($req.entries)) {
    $particulars = [string]$e.particulars
    if ($particulars.Trim().Length -eq 0) { continue }
    $find = $particulars
    if (Has $e 'find') { $find = [string]$e.find }
    $end = ''
    if (Has $e 'end') { $end = [string]$e.end }
    [void]$entries.Add(@{ particulars = $particulars; find = $find; end = $end })
  }
  if ($entries.Count -lt 1) { Fail 'there are no entries for the index' }
  if ($entries.Count -gt 150) { Fail 'that is too many index entries for one go' }
  $labels = @('S. No.', 'Particulars', 'Page No.')
  if (Has $req 'headers') { $labels = @($req.headers | ForEach-Object { [string]$_ }) }
  if ($labels.Count -ne 3) { Fail 'the index has three column headings: number, particulars, page' }
  $at = 'cursor'
  if (Has $req 'at') { $at = [string]$req.at }
  $state = @{ missing = New-Object System.Collections.ArrayList; replaced = $false }
  [void](With-Undo $app 'index' {
    # An index Eya made earlier is replaced where it stood, not left beside the new one.
    if ($doc.Bookmarks.Exists('EyaIndexTable')) {
      try {
        $old = $doc.Bookmarks.Item('EyaIndexTable').Range
        if ([int]$old.Tables.Count -gt 0) {
          $s = [int]$old.Tables.Item(1).Range.Start
          $old.Tables.Item(1).Delete()
          $state.replaced = $true
          if (-not (Has $req 'at')) { $doc.Range($s, $s).Select() | Out-Null; $at = 'cursor' }
        }
      } catch { }
    }
    foreach ($b in @($doc.Bookmarks)) { if (([string]$b.Name).StartsWith('EyaIdx')) { $b.Delete() } }
    # Mark where each entry is, BEFORE the table goes in, so that the table's own words are never taken for the entry.
    for ($i = 0; $i -lt $entries.Count; $i++) {
      $e = $entries[$i]
      $p = Find-Paragraph $doc $e.find $false
      if ($null -eq $p) { [void]$state.missing.Add($e.particulars); $e.found = $false; continue }
      # Anchored on a character INSIDE the line, not its first one: a page break put in front of the heading lands at its very start and
      # would otherwise sit inside the bookmark, leaving the index on the page before.
      $len = ([string]$p.Text).TrimEnd($CR).Length
      $at0 = [int]$p.Start
      if ($len -ge 2) { $at0 = $at0 + 1 }
      [void]$doc.Bookmarks.Add('EyaIdx_' + ($i + 1), $doc.Range($at0, $at0 + 1))
      $e.found = $true
      if ($e.end.Length -gt 0) {
        $q = Find-Paragraph $doc $e.end $false
        if ($null -ne $q) {
          $qlen = ([string]$q.Text).TrimEnd($CR).Length
          $q0 = [int]$q.Start + [Math]::Max(0, $qlen - 1)
          [void]$doc.Bookmarks.Add('EyaIdxE_' + ($i + 1), $doc.Range($q0, $q0 + 1))
          $e.hasEnd = $true
        }
      }
    }
    $point = Get-BlockPoint $app $doc $at
    $start = [int]$point.Start
    if (Has $req 'title') {
      $point.InsertAfter([string]$req.title + $CR)
      $tr = $doc.Range($start, $start + ([string]$req.title).Length)
      $tr.Style = -1
      $tr.Font.Bold = -1
      $tr.ParagraphFormat.Alignment = 1
      $point = $doc.Range($start + ([string]$req.title).Length + 1, $start + ([string]$req.title).Length + 1)
    }
    $t = $doc.Tables.Add($point, $entries.Count + 1, 3)
    for ($c = 1; $c -le 3; $c++) { $t.Cell(1, $c).Range.Text = [string]$labels[$c - 1] }
    for ($i = 0; $i -lt $entries.Count; $i++) {
      $e = $entries[$i]
      $row = $i + 2
      $t.Cell($row, 1).Range.Text = [string]($i + 1)
      $t.Cell($row, 2).Range.Text = [string]$e.particulars
      if ($e.found) {
        $cell = $t.Cell($row, 3).Range
        $cell.Collapse(1)
        [void]$doc.Fields.Add($cell, -1, 'PAGEREF EyaIdx_' + ($i + 1) + ' \h', $false)
        if ($e.hasEnd) {
          $cell2 = $t.Cell($row, 3).Range
          $cell2.MoveEnd(1, -1) | Out-Null
          $cell2.Collapse(0)
          $cell2.InsertAfter(' - ')
          $cell3 = $t.Cell($row, 3).Range
          $cell3.MoveEnd(1, -1) | Out-Null
          $cell3.Collapse(0)
          [void]$doc.Fields.Add($cell3, -1, 'PAGEREF EyaIdxE_' + ($i + 1) + ' \h', $false)
        }
      } else {
        $t.Cell($row, 3).Range.Text = '-'
      }
    }
    Style-Table $app $t ([double[]]@(10, 70, 20))
    $t.Rows.Item(1).Range.Font.Bold = -1
    $t.Rows.Item(1).HeadingFormat = -1
    $t.Rows.Item(1).Range.ParagraphFormat.Alignment = 1
    for ($row = 2; $row -le $entries.Count + 1; $row++) { $t.Cell($row, 1).Range.ParagraphFormat.Alignment = 1; $t.Cell($row, 3).Range.ParagraphFormat.Alignment = 1 }
    [void]$doc.Bookmarks.Add('EyaIndexTable', $t.Range)
    $doc.Repaginate()
    [void]$t.Range.Fields.Update()
    $doc.Repaginate()
    [void]$t.Range.Fields.Update()
  })
  return @{ ok = $true; entries = $entries.Count; missing = @($state.missing); replaced = $state.replaced; pages = [int]$doc.ComputeStatistics(2) }
}

# ------------------------------------------------------------------------------------------- filling an index that is already there
# A petition usually has its INDEX table already (S.No / Particulars / Page No.) with the page cells empty. Filling it is: read each
# particular, find where that part is in the document (an "Annexure P-1" cover line, a heading like "SYNOPSIS"), and put its page in the
# cell as a live page-reference field, so the numbers follow the document as it grows. All of it on this PC, in one command, no model.

function Norm-Text([string]$s) {
  $t = $s.ToLowerInvariant()
  $t = [regex]::Replace($t, '[^\p{L}\p{N} ]+', ' ')
  return ([regex]::Replace($t, '\s+', ' ')).Trim()
}

function Cell-Plain($cell) { return ([string]$cell.Range.Text).Replace($CR, '').Replace($BEL, '').Trim() }

# The table that is the index: the one asked for, else the one whose first row has a "particulars"-like and a "page" heading.
function Find-IndexTable($doc, [int]$wanted) {
  $count = [int]$doc.Tables.Count
  if ($count -lt 1) { Fail 'the document has no table, so there is no index to fill' }
  if ($wanted -gt 0) {
    if ($wanted -gt $count) { Fail ('there is no table ' + $wanted + ' (the document has ' + $count + ')') }
    return $wanted
  }
  $fallback = 0
  for ($i = 1; $i -le $count; $i++) {
    try {
      $head = ([string]$doc.Tables.Item($i).Rows.Item(1).Range.Text).ToLowerInvariant()
      if ($head -match 'particular|description|documents?|subject|details|contents' -and $head -match 'page') { return $i }
      if ($head -match 'page' -and $fallback -eq 0) { $fallback = $i }
    } catch { }
  }
  if ($fallback -eq 0) { Fail 'I could not find an index table (a table with a "Particulars" column and a "Page" column)' }
  return $fallback
}

function Cmd-FillIndex($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $wanted = 0
  if (Has $req 'table') { $wanted = [int]$req.table }
  $ti = Find-IndexTable $doc $wanted
  $table = $doc.Tables.Item($ti)

  # which column holds the particulars and which the page
  $heads = New-Object System.Collections.ArrayList
  foreach ($c in $table.Rows.Item(1).Cells) { [void]$heads.Add((Norm-Text (Cell-Plain $c))) }
  $pageCol = 0
  $partCol = 0
  for ($i = 0; $i -lt $heads.Count; $i++) {
    if ($pageCol -eq 0 -and $heads[$i] -match 'page') { $pageCol = $i + 1 }
    elseif ($partCol -eq 0 -and $heads[$i] -match 'particular|description|document|subject|detail|content|annexure|name') { $partCol = $i + 1 }
  }
  if ($pageCol -eq 0) { Fail 'the table has no "Page" column to fill' }
  if ($partCol -eq 0) { $partCol = $(if ($pageCol -eq 2) { 1 } else { 2 }) }
  if ($partCol -eq $pageCol) { Fail 'I could not tell which column holds the particulars' }
  $headWords = ($heads -join ' ')
  $asRange = $headWords -match 'pages|page nos|page no s|pgs'
  if (Has $req 'ranges') { $asRange = [bool]$req.ranges }
  $live = $true
  if (Has $req 'fields') { $live = [bool]$req.fields }

  # the particulars, row by row
  $rowCount = [int]$table.Rows.Count
  if ($rowCount -gt 120) { $rowCount = 120 }
  $entries = New-Object System.Collections.ArrayList
  for ($r = 2; $r -le $rowCount; $r++) {
    $txt = ''
    try { $txt = Cell-Plain ($table.Cell($r, $partCol)) } catch { continue }
    if ($txt.Length -lt 2) { continue }
    $existing = ''
    try { $existing = Cell-Plain ($table.Cell($r, $pageCol)) } catch { }
    [void]$entries.Add(@{ row = $r; particulars = $txt; existing = $existing; start = 0; end = 0; found = $false })
    if (-not $asRange -and $existing -match '\d\s*[-–—]\s*\d') { $asRange = $true }
  }
  if ($entries.Count -eq 0) { Fail 'the index table has no particulars in it yet' }

  # where the document's own parts are: every paragraph's text, once, with the index table and the contents list left out
  $paras = Get-Paras $doc
  $excluded = New-Object 'System.Collections.Generic.HashSet[int]'
  $tableFrom = Para-Number $doc ([int]$table.Range.Start)
  $tableTo = Para-Number $doc ([Math]::Max([int]$table.Range.Start, [int]$table.Range.End - 1))
  for ($i = $tableFrom; $i -le $tableTo; $i++) { [void]$excluded.Add($i - 1) }
  foreach ($toc in $doc.TablesOfContents) {
    $a = Para-Number $doc ([int]$toc.Range.Start)
    $b = Para-Number $doc ([Math]::Max([int]$toc.Range.Start, [int]$toc.Range.End - 1))
    for ($i = $a; $i -le $b; $i++) { [void]$excluded.Add($i - 1) }
  }
  $norm = New-Object string[] $paras.Count
  for ($i = 0; $i -lt $paras.Count; $i++) {
    $p = $paras[$i]
    $norm[$i] = $(if ($p.Length -gt 0 -and $p.Length -le 160 -and -not $excluded.Contains($i)) { Norm-Text $p } else { '' })
  }
  $tableEnd = $tableTo - 1   # paragraph index (0-based) where the index table ends

  foreach ($e in $entries) {
    $label = $null
    $m = [regex]::Match([string]$e.particulars, '(?i)\b(annexure|annexures|exhibit|ex|schedule|appendix|document|doc)\s*[-.:]?\s*([A-Za-z]{0,3})\s*[-/. ]?\s*(\d{1,3}[A-Za-z]?)\b')
    if ($m.Success -and $m.Groups[1].Value -notmatch '^(?i)(document|doc)$') {
      $label = Norm-Text ($m.Groups[1].Value + ' ' + $m.Groups[2].Value + ' ' + $m.Groups[3].Value)
    }
    $head = Norm-Text (([regex]::Split([string]$e.particulars, '\s[-–—]\s|[:(]'))[0])
    $words = @($head -split ' ' | Where-Object { $_ -ne '' })
    $short = $(if ($words.Count -gt 4) { ($words[0..3] -join ' ') } else { $head })
    $bestAt = -1
    $bestScore = 0
    for ($i = 0; $i -lt $norm.Length; $i++) {
      $n = $norm[$i]
      if ($n.Length -eq 0) { continue }
      $score = 0
      if ($null -ne $label) {
        if ($n -eq $label) { $score = 5 } elseif ($n.StartsWith($label + ' ') -or $n.StartsWith($label)) { $score = 4 }
      } else {
        if ($head.Length -ge 4) {
          if ($n -eq $head) { $score = 5 }
          elseif ($n.StartsWith($head)) { $score = 4 }
          elseif ($n.Contains($head) -and $n.Length -le $head.Length + 30) { $score = 2 }
        }
        if ($score -eq 0 -and $short.Length -ge 4 -and $n.StartsWith($short) -and $n.Length -le $short.Length + 40) { $score = 1 }
      }
      if ($score -eq 0) { continue }
      # the part itself comes after the index in a petition; anything before it is only a second choice
      $adj = [double]$score + $(if ($i -gt $tableEnd) { 0.5 } else { 0 })
      if ($adj -gt $bestScore) { $bestScore = $adj; $bestAt = $i }
    }
    if ($bestAt -ge 0) { $e.at = $bestAt; $e.found = $true }
  }

  # each found part runs to the paragraph before the next found part starts
  $foundOnes = @($entries | Where-Object { $_.found } | Sort-Object { $_.at })
  $lastReal = $paras.Count - 1
  while ($lastReal -gt 0 -and ($paras[$lastReal].Trim() -eq '' -or $paras[$lastReal] -eq [string][char]12)) { $lastReal-- }
  for ($k = 0; $k -lt $foundOnes.Count; $k++) {
    $e = $foundOnes[$k]
    $endAt = $lastReal
    if ($k + 1 -lt $foundOnes.Count) { $endAt = [int]$foundOnes[$k + 1].at - 1 }
    while ($endAt -gt [int]$e.at -and ($paras[$endAt].Trim() -eq '' -or $paras[$endAt] -eq [string][char]12)) { $endAt-- }
    $e.endAt = [Math]::Max([int]$e.at, $endAt)
  }

  $state = @{ filled = 0 }
  [void](With-Undo $app 'fill index' {
    foreach ($b in @($doc.Bookmarks)) { if (([string]$b.Name).StartsWith('EyaFill')) { $b.Delete() } }
    foreach ($e in $foundOnes) {
      $p = $doc.Paragraphs.Item([int]$e.at + 1).Range
      $len = ([string]$p.Text).TrimEnd($CR).Length
      $at0 = [int]$p.Start
      if ($len -ge 2) { $at0 = $at0 + 1 }   # inside the line, so a page break put in front of it does not pull the entry back a page
      $e.page = 0
      try { $e.page = [int]$doc.Range([int]$p.Start, [int]$p.Start).Information(1) } catch { }
      $q = $doc.Paragraphs.Item([int]$e.endAt + 1).Range
      $qlen = ([string]$q.Text).TrimEnd($CR).Length
      $q0 = [int]$q.Start + [Math]::Max(0, $qlen - 1)
      $e.endPage = $e.page
      try { $e.endPage = [int]$doc.Range($q0, $q0).Information(1) } catch { }
      if ($live) {
        [void]$doc.Bookmarks.Add('EyaFill_' + $e.row, $doc.Range($at0, $at0 + 1))
        [void]$doc.Bookmarks.Add('EyaFillE_' + $e.row, $doc.Range($q0, $q0 + 1))
      }
      $cell = $table.Cell([int]$e.row, $pageCol)
      $body = $cell.Range
      [void]$body.MoveEnd(1, -1)
      $body.Text = ''
      $useRange = $asRange -and ([int]$e.endPage -gt [int]$e.page)
      if ($live) {
        $pos = $table.Cell([int]$e.row, $pageCol).Range
        $pos.Collapse(1)
        [void]$doc.Fields.Add($pos, -1, 'PAGEREF EyaFill_' + $e.row + ' \h', $false)
        if ($useRange) {
          $tail = $table.Cell([int]$e.row, $pageCol).Range
          [void]$tail.MoveEnd(1, -1)
          $tail.Collapse(0)
          $tail.InsertAfter(' - ')
          $tail2 = $table.Cell([int]$e.row, $pageCol).Range
          [void]$tail2.MoveEnd(1, -1)
          $tail2.Collapse(0)
          [void]$doc.Fields.Add($tail2, -1, 'PAGEREF EyaFillE_' + $e.row + ' \h', $false)
        }
      } else {
        $table.Cell([int]$e.row, $pageCol).Range.Text = $(if ($useRange) { [string]$e.page + ' - ' + [string]$e.endPage } else { [string]$e.page })
      }
      $state.filled++
    }
    $doc.Repaginate()
    if ($live) { [void]$table.Range.Fields.Update() }
  })

  $report = New-Object System.Collections.ArrayList
  foreach ($e in $entries) {
    $row = @{ row = $e.row; particulars = (Clip ([string]$e.particulars) 70); found = [bool]$e.found }
    if ($e.found) { $row.page = $e.page; if ($asRange -and [int]$e.endPage -gt [int]$e.page) { $row.endPage = $e.endPage } }
    [void]$report.Add($row)
  }
  $missing = @($entries | Where-Object { -not $_.found } | ForEach-Object { Clip ([string]$_.particulars) 70 })
  return @{ ok = $true; table = $ti; filled = $state.filled; notFound = @($missing); entries = @($report); ranges = $asRange; live = $live; pages = [int]$doc.ComputeStatistics(2) }
}

function Cmd-HeaderFooter($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $where = 'header'
  if (Has $req 'where') { $where = ([string]$req.where).ToLowerInvariant() }
  if ($where -ne 'header' -and $where -ne 'footer') { Fail 'where must be header or footer' }
  $text = ''
  if (Has $req 'text') { $text = [string]$req.text }
  $align = ''
  if (Has $req 'align') { $align = [string]$req.align }
  $state = @{ sections = 0 }
  [void](With-Undo $app $where {
    $i = 0
    foreach ($sec in $doc.Sections) {
      $i++
      $hf = $(if ($where -eq 'header') { $sec.Headers.Item(1) } else { $sec.Footers.Item(1) })
      if ($i -gt 1 -and [bool]$hf.LinkToPrevious) { continue }
      Set-HeaderFooterParts $doc $hf $text $align
      if (Has $req 'bold') { $hf.Range.Font.Bold = $(if ([bool]$req.bold) { -1 } else { 0 }) }
      if (Has $req 'fontSize') { $hf.Range.Font.Size = [double]$req.fontSize }
      $state.sections++
    }
  })
  return @{ ok = $true; where = $where; sections = $state.sections }
}

function Cmd-PageSetup($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $changed = New-Object System.Collections.ArrayList
  $papers = @{ 'a4' = 7; 'a3' = 6; 'a5' = 9; 'legal' = 4; 'letter' = 2 }
  [void](With-Undo $app 'page setup' {
    foreach ($sec in $doc.Sections) {
      $ps = $sec.PageSetup
      if (Has $req 'orientation') {
        $o = ([string]$req.orientation).ToLowerInvariant()
        if ($o -eq 'landscape') { $ps.Orientation = 1 } elseif ($o -eq 'portrait') { $ps.Orientation = 0 } else { Fail 'orientation must be portrait or landscape' }
      }
      if (Has $req 'paper') {
        $p = ([string]$req.paper).ToLowerInvariant()
        if (-not $papers.ContainsKey($p)) { Fail 'paper must be a4, a3, a5, legal or letter' }
        $ps.PaperSize = [int]$papers[$p]
      }
      if (Has $req 'marginTopCm') { $ps.TopMargin = $app.CentimetersToPoints([double]$req.marginTopCm) }
      if (Has $req 'marginBottomCm') { $ps.BottomMargin = $app.CentimetersToPoints([double]$req.marginBottomCm) }
      if (Has $req 'marginLeftCm') { $ps.LeftMargin = $app.CentimetersToPoints([double]$req.marginLeftCm) }
      if (Has $req 'marginRightCm') { $ps.RightMargin = $app.CentimetersToPoints([double]$req.marginRightCm) }
    }
  })
  $ps1 = $doc.Sections.Item(1).PageSetup
  return @{ ok = $true; orientation = $(if ([int]$ps1.Orientation -eq 1) { 'landscape' } else { 'portrait' })
    marginsCm = @{ top = [Math]::Round([double]$app.PointsToCentimeters($ps1.TopMargin), 2); bottom = [Math]::Round([double]$app.PointsToCentimeters($ps1.BottomMargin), 2)
      left = [Math]::Round([double]$app.PointsToCentimeters($ps1.LeftMargin), 2); right = [Math]::Round([double]$app.PointsToCentimeters($ps1.RightMargin), 2) }
    pages = [int]$doc.ComputeStatistics(2) }
}

function Cmd-Break($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $kind = 'page'
  if (Has $req 'kind') { $kind = ([string]$req.kind).ToLowerInvariant() }
  $type = $(if ($kind -eq 'section') { 2 } elseif ($kind -eq 'page') { 7 } else { Fail 'a break is a page or a section' })
  $at = 'cursor'
  if (Has $req 'at') { $at = [string]$req.at }
  [void](With-Undo $app 'break' {
    if ($at -eq 'cursor') {
      $r = $app.Selection.Range
      $r.Collapse(0)
      $r.InsertBreak($type)
    } else {
      $point = Get-BlockPoint $app $doc $at
      $point.InsertBreak($type)
    }
  })
  return @{ ok = $true; kind = $kind; pages = [int]$doc.ComputeStatistics(2) }
}

function Cmd-Fields($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  [void](With-Undo $app 'update fields' {
    $doc.Repaginate()
    [void]$doc.Fields.Update()
    foreach ($t in $doc.TablesOfContents) { $t.Update() }
    $doc.Repaginate()
    [void]$doc.Fields.Update()
    foreach ($sec in $doc.Sections) {
      foreach ($i in 1, 2, 3) {
        try { [void]$sec.Headers.Item($i).Range.Fields.Update() } catch { }
        try { [void]$sec.Footers.Item($i).Range.Fields.Update() } catch { }
      }
    }
  })
  return @{ ok = $true; pages = [int]$doc.ComputeStatistics(2) }
}

function Cmd-Replace($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $find = [string]$req.find
  $with = [string]$req.replace
  if ($find.Length -lt 1) { Fail 'there is nothing to look for' }
  if ($find.Length -gt 250 -or $with.Length -gt 250) { Fail 'Word can only replace pieces of text up to 250 characters' }
  $matchCase = (Has $req 'matchCase') -and [bool]$req.matchCase
  $all = Find-All $doc $find 1000 $matchCase
  $count = [int]$all.Count
  if ($count -eq 0) { return @{ ok = $true; replaced = 0 } }
  $confirmed = (Has $req 'confirm') -and [bool]$req.confirm
  if ($count -gt 8 -and -not $confirmed) { return @{ ok = $false; needsConfirm = $true; count = $count; why = ('"' + $find + '" appears ' + $count + ' times') } }
  [void](With-Undo $app 'replace' {
    $r = $doc.Content
    $f = $r.Find
    $f.ClearFormatting()
    $f.Replacement.ClearFormatting()
    [void]$f.Execute((Escape-Find $find), $matchCase, $false, $false, $false, $false, $true, 0, $false, (Escape-Find $with), 2)
  })
  return @{ ok = $true; replaced = $count }
}

function Cmd-Delete($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $target = 'selection'
  if (Has $req 'target') { $target = [string]$req.target }
  $res = Resolve-Target $app $doc $target
  $paragraphs = 0
  $chars = 0
  foreach ($r in $res.ranges) { $paragraphs += [int]$r.Paragraphs.Count; $chars += ([int]$r.End - [int]$r.Start) }
  $confirmed = (Has $req 'confirm') -and [bool]$req.confirm
  $big = ($target.Trim() -eq 'document') -or ($paragraphs -gt 1) -or ($chars -gt 300) -or ($res.ranges.Count -gt 1)
  if ($big -and -not $confirmed) {
    $first = $res.ranges[0]
    return @{ ok = $false; needsConfirm = $true; paragraphs = $paragraphs; characters = $chars; places = [int]$res.ranges.Count
      preview = (Clip ([string]$first.Text).Replace($CR, ' ').Trim() 90); why = 'this would remove a lot' }
  }
  [void](With-Undo $app 'delete' {
    $list = @($res.ranges)
    [array]::Reverse($list)
    foreach ($r in $list) { [void]$r.Delete() }
  })
  return @{ ok = $true; deletedCharacters = $chars; paragraphs = $paragraphs }
}

function Cmd-Undo($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  $n = 1
  if (Has $req 'times') { $n = [Math]::Min(20, [Math]::Max(1, [int]$req.times)) }
  $kind = 'undo'
  if (Has $req 'kind') { $kind = [string]$req.kind }
  $ok = $(if ($kind -eq 'redo') { [bool]$doc.Redo($n) } else { [bool]$doc.Undo($n) })
  return @{ ok = $ok; times = $n; kind = $kind; why = $(if ($ok) { '' } else { 'there is nothing left to ' + $kind }) }
}

function Cmd-Save($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  if (([string]$doc.Path).Length -eq 0) { Fail 'this document has not been saved yet and has no file name, so ask the user where to save it' }
  $doc.Save()
  return @{ ok = $true; name = [string]$doc.Name; path = [string]$doc.Path }
}

function Cmd-Goto($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  $pages = [int]$doc.ComputeStatistics(2)
  $note = ''
  if (Has $req 'page') {
    $want = [int]$req.page
    if ($want -lt 1) { Fail 'page numbers start at 1' }
    if ($want -gt $pages) { Fail ('the document has only ' + $pages + ' page' + $(if ($pages -eq 1) { '' } else { 's' })) }
    [void]$app.Selection.GoTo(1, 1, $want)
  } else {
    $where = 'target'
    if (Has $req 'where') { $where = ([string]$req.where).ToLowerInvariant() }
    if ($where -eq 'next_page') { [void]$app.Selection.GoTo(1, 2, 1) }
    elseif ($where -eq 'previous_page') { [void]$app.Selection.GoTo(1, 3, 1) }
    else {
      $pos = 0
      if ($where -eq 'end') { $pos = [int]$doc.Content.End - 1 }
      elseif ($where -eq 'start') { $pos = 0 }
      else {
        if (-not (Has $req 'target')) { Fail 'say where to go: a page number, start, end, next_page, previous_page, or a target' }
        $res = Resolve-Target $app $doc ([string]$req.target)
        $pos = [int]$res.ranges[0].Start
        if ($where -eq 'after') { $pos = [int]$res.ranges[0].End - 1 }
      }
      $app.Selection.SetRange($pos, $pos)
    }
  }
  try { $app.ActiveWindow.ScrollIntoView($app.Selection.Range, $true) } catch { }
  $page = 0
  try { $page = [int]$app.Selection.Information(3) } catch { }
  return @{ ok = $true; paragraph = (Para-Number $doc ([int]$app.Selection.Start)); page = $page; pages = $pages }
}

# Moving the VIEW (scrolling), not the cursor: "scroll down", "scroll up".
function Cmd-Scroll($req) {
  $app = Need-App
  $dir = 'down'
  if (Has $req 'direction') { $dir = ([string]$req.direction).ToLowerInvariant() }
  $times = 1
  if (Has $req 'times') { $times = [Math]::Min(30, [Math]::Max(1, [int]$req.times)) }
  $win = $app.ActiveWindow
  if ($dir -eq 'down') { [void]$win.LargeScroll($times) }
  elseif ($dir -eq 'up') { [void]$win.LargeScroll([Type]::Missing, $times) }
  else { Fail 'scroll direction must be down or up' }
  return @{ ok = $true; direction = $dir; times = $times }
}

function Cmd-New($req) {
  $app = Get-App $true
  $doc = $app.Documents.Add()
  return @{ ok = $true; name = [string]$doc.Name }
}

# ---------------------------------------------------------------------------------------------- reading a document as a reference
# A reference document is read to learn from: its structure, how it is formatted, and on which page each part is. A file is opened in a
# Word of its own (hidden, read-only, macros off), never in the user's Word, so their windows and documents are not touched.
$script:RefApp = $null
$script:RefDoc = $null

function Close-RefDoc() {
  if ($null -ne $script:RefDoc) {
    try { $script:RefDoc.Saved = $true; $script:RefDoc.Close() } catch { }
    $script:RefDoc = $null
  }
}

function Close-RefApp() {
  Close-RefDoc
  if ($null -ne $script:RefApp) {
    try { $script:RefApp.Quit() } catch { }
    $script:RefApp = $null
  }
}

function Get-RefApp() {
  if ($null -eq $script:RefApp) {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    try { $app.AutomationSecurity = 3 } catch { }
    $script:RefApp = $app
  }
  return $script:RefApp
}

# The document to read: the file in the path (opened in our own Word) or, with no path, the one in front in the user's Word.
function Get-RefTarget($req) {
  if (Has $req 'path') {
    $path = [string]$req.path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail 'that file does not exist' }
    Close-RefDoc
    $app = Get-RefApp
    try {
      $script:RefDoc = $app.Documents.Open($path, $false, $true, $false, '', '', $false, '', '', 0, [Type]::Missing, $false)
    } catch {
      Fail 'Word could not open that file (it may need a password, or not be a Word document)'
    }
    return $script:RefDoc
  }
  if (Has $req 'useAnalyzed') {
    if ($null -eq $script:RefDoc) { Fail 'no reference document is open' }
    return $script:RefDoc
  }
  $app = Need-App
  return $app.ActiveDocument
}

function Cmd-Analyze($req) {
  $doc = Get-RefTarget $req
  $info = [ordered]@{ ok = $true }
  $info.name = [string]$doc.Name
  $info.pages = [int]$doc.ComputeStatistics(2)
  $info.words = [int]$doc.ComputeStatistics(0)
  $info.tables = [int]$doc.Tables.Count
  $info.tablesOfContents = [int]$doc.TablesOfContents.Count
  $info.sections = [int]$doc.Sections.Count
  try {
    $ps = $doc.Sections.Item(1).PageSetup
    $app2 = $doc.Application
    # the paper by its real size (Word reports a slightly different A4 as "custom")
    $pw = [double]$ps.PageWidth
    $ph = [double]$ps.PageHeight
    $short = [Math]::Min($pw, $ph)
    $long = [Math]::Max($pw, $ph)
    $near = { param($a, $b) [Math]::Abs($a - $b) -le 4 }
    $paper = 'other'
    if ((& $near $short 595.3) -and (& $near $long 841.9)) { $paper = 'a4' }
    elseif ((& $near $short 612) -and (& $near $long 792)) { $paper = 'letter' }
    elseif ((& $near $short 612) -and (& $near $long 1008)) { $paper = 'legal' }
    elseif ((& $near $short 841.9) -and (& $near $long 1190.6)) { $paper = 'a3' }
    elseif ((& $near $short 419.5) -and (& $near $long 595.3)) { $paper = 'a5' }
    $info.pageSetup = @{
      paper = $paper
      orientation = $(if ([int]$ps.Orientation -eq 1) { 'landscape' } else { 'portrait' })
      marginTopCm = [Math]::Round([double]$app2.PointsToCentimeters($ps.TopMargin), 2)
      marginBottomCm = [Math]::Round([double]$app2.PointsToCentimeters($ps.BottomMargin), 2)
      marginLeftCm = [Math]::Round([double]$app2.PointsToCentimeters($ps.LeftMargin), 2)
      marginRightCm = [Math]::Round([double]$app2.PointsToCentimeters($ps.RightMargin), 2)
    }
    $info.header = Clip ([string]$doc.Sections.Item(1).Headers.Item(1).Range.Text).Replace($CR, ' ').Trim() 200
    $info.footer = Clip ([string]$doc.Sections.Item(1).Footers.Item(1).Range.Text).Replace($CR, ' ').Trim() 200
    $pn = 0
    foreach ($f in $doc.Sections.Item(1).Footers.Item(1).Range.Fields) { if ([int]$f.Type -eq 33) { $pn++ } }
    foreach ($f in $doc.Sections.Item(1).Headers.Item(1).Range.Fields) { if ([int]$f.Type -eq 33) { $pn++ } }
    $info.pageNumbers = ($pn -gt 0)
    $info.differentFirstPage = [bool]$doc.Sections.Item(1).PageSetup.DifferentFirstPageHeaderFooter
  } catch { }
  try {
    $normal = $doc.Styles.Item(-1)
    $info.normal = @{ font = [string]$normal.Font.Name; size = [double]$normal.Font.Size; lineSpacingRule = [int]$normal.ParagraphFormat.LineSpacingRule; align = [int]$normal.ParagraphFormat.Alignment }
  } catch { }
  # The whole body as Word's own XML, in ONE call (asking about each paragraph would take minutes on a long petition).
  $xml = [string]$doc.Content.WordOpenXML
  $i = $xml.IndexOf('<w:body>')
  $j = $xml.LastIndexOf('</w:body>')
  if ($i -lt 0 -or $j -lt $i) { Fail 'Word did not give the document structure' }
  $body = $xml.Substring($i, $j - $i + 9)
  $body = [regex]::Replace($body, ' w:rsid\w*="[^"]*"', '')
  $body = [regex]::Replace($body, '<w:proofErr [^>]*/>', '')
  $body = [regex]::Replace($body, '<w:bookmark(Start|End) [^>]*/>', '')
  if ($body.Length -gt 6000000) { Fail 'that document is too large to learn from in one go' }
  $info.bodyXml = $body
  return $info
}

# The page each given heading starts on (0 when it cannot be found), from the document just analysed or the one in front.
function Cmd-PagesOf($req) {
  $doc = Get-RefTarget $req
  $pages = New-Object System.Collections.ArrayList
  foreach ($t in @($req.titles)) {
    $page = 0
    try {
      $p = Find-Paragraph $doc ([string]$t) $false
      if ($null -ne $p) { $page = [int]$p.Information(3) }
    } catch { }
    [void]$pages.Add($page)
  }
  return @{ ok = $true; pages = @($pages); total = [int]$doc.ComputeStatistics(2) }
}

function Cmd-AnalyzeClose($req) {
  Close-RefApp
  return @{ ok = $true }
}

# Making the document in front look like a reference, in ONE undo step: page setup, the body's font / size / spacing / alignment / indent,
# how the section titles look, and page numbers. Tables are left as they are.
function Cmd-ApplyProfile($req) {
  $app = Need-App
  $doc = $app.ActiveDocument
  Need-Editable $doc
  $done = New-Object System.Collections.ArrayList
  $missing = New-Object System.Collections.ArrayList
  [void](With-Undo $app 'format like the reference' {
    if (Has $req 'pageSetup') {
      $setup = @{}
      foreach ($k in 'paper', 'orientation', 'marginTopCm', 'marginBottomCm', 'marginLeftCm', 'marginRightCm') {
        if (Has $req.pageSetup $k) { $setup[$k] = $req.pageSetup.$k }
      }
      $setup.cmd = 'page_setup'
      [void](Cmd-PageSetup ([pscustomobject]$setup))
      [void]$done.Add('page setup')
    }
    if (Has $req 'body') {
      # everything outside the tables: the stretches between them
      $stretches = New-Object System.Collections.ArrayList
      $at = [int]$doc.Content.Start
      foreach ($t in $doc.Tables) {
        $ts = [int]$t.Range.Start
        if ($ts -gt $at) { [void]$stretches.Add($doc.Range($at, $ts)) }
        $at = [int]$t.Range.End
      }
      if ($at -lt [int]$doc.Content.End) { [void]$stretches.Add($doc.Range($at, [int]$doc.Content.End)) }
      foreach ($r in $stretches) { [void](Apply-Format $app $r $req.body) }
      [void]$done.Add('body text')
    }
    if (Has $req 'titles') {
      $count = 0
      foreach ($t in @($req.titles)) {
        $p = Find-Paragraph $doc ([string]$t.text) $false
        if ($null -eq $p) { [void]$missing.Add([string]$t.text); continue }
        [void](Apply-Format $app $p $t)
        $count++
      }
      [void]$done.Add($count.ToString() + ' section titles')
    }
    if (Has $req 'pageNumbers') {
      $pn = $req.pageNumbers
      if ([bool]$pn.present) {
        $one = @{ cmd = 'page_numbers'; where = $(if (Has $pn 'where') { [string]$pn.where } else { 'footer' }); align = $(if (Has $pn 'align') { [string]$pn.align } else { 'center' }); format = $(if (Has $pn 'format') { [string]$pn.format } else { 'number' }) }
        [void](Cmd-PageNumbers ([pscustomobject]$one))
        [void]$done.Add('page numbers')
      }
    }
  })
  return @{ ok = $true; applied = @($done); titlesNotFound = @($missing); pages = [int]$doc.ComputeStatistics(2) }
}

function Run-Cmd($req) {
  switch ([string]$req.cmd) {
    'status' { return (Cmd-Status $req) }
    'read' { return (Cmd-Read $req) }
    'write' { return (Cmd-Write $req) }
    'format' { return (Cmd-Format $req) }
    'page_numbers' { return (Cmd-PageNumbers $req) }
    'toc' { return (Cmd-Toc $req) }
    'table' { return (Cmd-Table $req) }
    'index' { return (Cmd-Index $req) }
    'fill_index' { return (Cmd-FillIndex $req) }
    'header_footer' { return (Cmd-HeaderFooter $req) }
    'page_setup' { return (Cmd-PageSetup $req) }
    'break' { return (Cmd-Break $req) }
    'fields' { return (Cmd-Fields $req) }
    'replace' { return (Cmd-Replace $req) }
    'delete' { return (Cmd-Delete $req) }
    'undo' { return (Cmd-Undo $req) }
    'redo' { $req | Add-Member -NotePropertyName kind -NotePropertyValue 'redo' -Force; return (Cmd-Undo $req) }
    'save' { return (Cmd-Save $req) }
    'goto' { return (Cmd-Goto $req) }
    'scroll' { return (Cmd-Scroll $req) }
    'new' { return (Cmd-New $req) }
    'analyze' { return (Cmd-Analyze $req) }
    'pages_of' { return (Cmd-PagesOf $req) }
    'analyze_close' { return (Cmd-AnalyzeClose $req) }
    'apply_profile' { return (Cmd-ApplyProfile $req) }
    default { Fail 'unknown command' }
  }
}

# Only ever the test instance this helper started itself (EYA_WORD_PRIVATE=1), never the user's own Word.
function Close-Private() {
  Close-RefApp
  if ($null -ne $script:PrivateApp) {
    try { foreach ($d in @($script:PrivateApp.Documents)) { $d.Saved = $true } } catch { }
    try { $script:PrivateApp.Quit() } catch { }
    $script:PrivateApp = $null
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
    if ([string]$req.cmd -eq 'quit') { Out-Line @{ id = $id; bye = $true }; break }
    $answer = Invoke-Retry { Run-Cmd $req }
    $answer.id = $id
    Out-Line $answer
  } catch {
    $msg = [string]$_.Exception.Message
    if ($msg.StartsWith('EYA:')) { Out-Line @{ id = $id; ok = $false; why = $msg.Substring(4) } }
    else {
      $busy = $msg -match 'rejected|busy|RPC'
      Out-Line @{ id = $id; ok = $false; why = $(if ($busy) { 'Word is busy right now (a dialog may be open); try again in a moment' } else { 'Word would not do that' }); detail = (Clip $msg 200) }
    }
  }
}
Close-Private
