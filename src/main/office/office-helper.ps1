# Eya's Excel and PowerPoint helper: a PowerShell program that stays running and answers one JSON line at a time, driving Microsoft Excel and
# PowerPoint through their own automation interfaces (all on this PC; nothing leaves it). Started through ReaderProcess, like the Word helper.
#
# Excel and PowerPoint cannot undo what automation does, so this helper protects instead: it will not write over cells that already hold
# something, delete a sheet or a slide, unless it is told to (confirm); it never saves, closes or prints on its own.
#
# EYA_OFFICE_PRIVATE=1 (tests only): use an Excel / PowerPoint of its own, hidden, instead of the user's running one.
#
# Requests:  {"id":1,"cmd":"excel","op":"status"}   cmd: excel | powerpoint   (and quit)
# Answers:   {"id":1,"ok":true,...}  or  {"id":1,"ok":false,"why":"..."}  or  {"id":1,"ok":false,"needsConfirm":true,"why":"..."}

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$CR = [string][char]13
$LF = [string][char]10
$script:PrivXl = $null
$script:PrivPpt = $null

function Out-Line($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8)) }
function Has($o, [string]$name) { return ($null -ne $o) -and ($o.PSObject.Properties.Name -contains $name) -and ($null -ne $o.$name) }
function Fail([string]$why) { throw ('EYA:' + $why) }
function Confirm-Needed([string]$why) { throw ('EYACONFIRM:' + $why) }
function Clip([string]$s, [int]$n) { if ($s.Length -le $n) { return $s } else { return $s.Substring(0, $n) } }

$ColorNames = @{ 'black' = 0; 'red' = 255; 'blue' = 16711680; 'green' = 32768; 'yellow' = 65535; 'orange' = 26367; 'purple' = 8388736;
  'gray' = 8421504; 'grey' = 8421504; 'white' = 16777215; 'darkblue' = 8388608; 'darkred' = 128 }

function To-Bgr([string]$c) {
  $s = $c.Trim().ToLowerInvariant()
  if ($ColorNames.ContainsKey($s)) { return [int]$ColorNames[$s] }
  if ($s -match '^#?([0-9a-f]{6})$') {
    $h = $Matches[1]
    return ([Convert]::ToInt32($h.Substring(0, 2), 16) + 256 * [Convert]::ToInt32($h.Substring(2, 2), 16) + 65536 * [Convert]::ToInt32($h.Substring(4, 2), 16))
  }
  Fail ('I do not know the colour ' + $c)
}

# ------------------------------------------------------------------------------------------------------------------------- Excel
function Get-Xl([bool]$create) {
  if ($env:EYA_OFFICE_PRIVATE -eq '1') {
    if ($null -eq $script:PrivXl -and $create) {
      $script:PrivXl = New-Object -ComObject Excel.Application
      $script:PrivXl.Visible = $false
      $script:PrivXl.DisplayAlerts = $false
    }
    return $script:PrivXl
  }
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') } catch { }
  if ($create) { $a = New-Object -ComObject Excel.Application; $a.Visible = $true; return $a }
  return $null
}

function Need-Xl() {
  $a = Get-Xl $false
  if ($null -eq $a) { Fail 'Excel is not open' }
  if ([int]$a.Workbooks.Count -lt 1) { Fail 'no workbook is open in Excel' }
  return $a
}

function Get-Sheet($app, $req) {
  $wb = $app.ActiveWorkbook
  if (Has $req 'sheet') {
    try { return $wb.Worksheets.Item([string]$req.sheet) } catch { Fail ('there is no sheet called ' + [string]$req.sheet) }
  }
  return $app.ActiveSheet
}

function Need-Writable($app) {
  if ([bool]$app.ActiveWorkbook.ReadOnly) { Fail 'the workbook is read-only' }
}

function Xl-Status($req) {
  $app = Get-Xl $false
  if ($null -eq $app) { return @{ ok = $true; found = $false; why = 'Excel is not open' } }
  $books = New-Object System.Collections.ArrayList
  foreach ($wb in $app.Workbooks) {
    $sheets = New-Object System.Collections.ArrayList
    foreach ($ws in $wb.Worksheets) { [void]$sheets.Add(@{ name = [string]$ws.Name; used = [string]$ws.UsedRange.Address($false, $false) }) }
    [void]$books.Add(@{ name = [string]$wb.Name; saved = [bool]$wb.Saved; hasPath = ([string]$wb.Path).Length -gt 0; sheets = @($sheets) })
  }
  $active = ''
  $activeSheet = ''
  try { $active = [string]$app.ActiveWorkbook.Name; $activeSheet = [string]$app.ActiveSheet.Name } catch { }
  return @{ ok = $true; found = ([int]$app.Workbooks.Count -gt 0); workbooks = @($books); active = $active; activeSheet = $activeSheet }
}

function Xl-Read($req) {
  $app = Need-Xl
  $ws = Get-Sheet $app $req
  $rng = $null
  if (Has $req 'range') { try { $rng = $ws.Range([string]$req.range) } catch { Fail ('I do not understand the range ' + [string]$req.range) } } else { $rng = $ws.UsedRange }
  $rows = [int]$rng.Rows.Count
  $cols = [int]$rng.Columns.Count
  $maxCells = 600
  $truncated = $false
  if (($rows * $cols) -gt $maxCells) {
    $rows = [Math]::Max(1, [int][Math]::Floor($maxCells / [Math]::Max(1, $cols)))
    $rng = $rng.Resize($rows, $cols)
    $truncated = $true
  }
  $raw = $rng.Value2
  $values = New-Object System.Collections.ArrayList
  if ($raw -is [System.Array]) {
    for ($r = 1; $r -le $rows; $r++) {
      $line = New-Object System.Collections.ArrayList
      for ($c = 1; $c -le $cols; $c++) { $v = $raw[$r, $c]; [void]$line.Add($(if ($null -eq $v) { '' } else { $v })) }
      [void]$values.Add(@($line))
    }
  } else { [void]$values.Add(@($(if ($null -eq $raw) { '' } else { $raw }))) }
  $out = @{ ok = $true; sheet = [string]$ws.Name; address = [string]$rng.Address($false, $false); rows = $rows; columns = $cols; values = @($values); truncated = $truncated }
  if ((Has $req 'formulas') -and [bool]$req.formulas) {
    $f = $rng.Formula
    $list = New-Object System.Collections.ArrayList
    if ($f -is [System.Array]) {
      for ($r = 1; $r -le $rows; $r++) {
        $line = New-Object System.Collections.ArrayList
        for ($c = 1; $c -le $cols; $c++) { $one = $f[$r, $c]; [void]$line.Add([string]$one) }
        [void]$list.Add(@($line))
      }
    } else { [void]$list.Add(@([string]$f)) }
    $out.formulas = @($list)
  }
  return $out
}

function Xl-Write($req) {
  $app = Need-Xl
  Need-Writable $app
  $ws = Get-Sheet $app $req
  if (-not (Has $req 'values')) { Fail 'there are no values to write' }
  $rowsIn = @($req.values)
  if ($rowsIn.Count -lt 1) { Fail 'there are no values to write' }
  $nr = $rowsIn.Count
  $nc = 0
  foreach ($row in $rowsIn) { $n = @($row).Count; if ($n -gt $nc) { $nc = $n } }
  if ($nc -lt 1) { Fail 'there are no values to write' }
  if (($nr * $nc) -gt 5000) { Fail 'that is too much to write in one go (5,000 cells at most)' }
  $start = 'A1'
  if (Has $req 'range') { $start = ([string]$req.range).Split(':')[0] }
  $target = $null
  try { $target = $ws.Range($start).Resize($nr, $nc) } catch { Fail ('I do not understand the place ' + $start) }
  $filled = 0
  try { $filled = [int]$app.WorksheetFunction.CountA($target) } catch { }
  $overwrite = (Has $req 'overwrite') -and [bool]$req.overwrite
  if ($filled -gt 0 -and -not $overwrite) { Confirm-Needed ($filled.ToString() + ' of those cells already have something in them (' + $target.Address($false, $false) + ')') }
  $arr = New-Object 'object[,]' $nr, $nc
  for ($r = 0; $r -lt $nr; $r++) {
    $row = @($rowsIn[$r])
    for ($c = 0; $c -lt $nc; $c++) { $arr[$r, $c] = $(if ($c -lt $row.Count -and $null -ne $row[$c]) { $row[$c] } else { $null }) }
  }
  $target.Value2 = $arr
  return @{ ok = $true; sheet = [string]$ws.Name; address = [string]$target.Address($false, $false); written = ($nr * $nc); replaced = $filled }
}

function Xl-Formula($req) {
  $app = Need-Xl
  Need-Writable $app
  $ws = Get-Sheet $app $req
  if (-not (Has $req 'range') -or -not (Has $req 'formula')) { Fail 'a range and a formula are needed' }
  $rng = $ws.Range([string]$req.range)
  $filled = 0
  try { $filled = [int]$app.WorksheetFunction.CountA($rng) } catch { }
  if ($filled -gt 0 -and -not ((Has $req 'overwrite') -and [bool]$req.overwrite)) { Confirm-Needed ($filled.ToString() + ' of those cells already have something in them') }
  $rng.Formula = [string]$req.formula
  $app.Calculate()
  return @{ ok = $true; sheet = [string]$ws.Name; address = [string]$rng.Address($false, $false); first = [string]$rng.Cells.Item(1, 1).Text }
}

function Xl-Format($req) {
  $app = Need-Xl
  Need-Writable $app
  $ws = Get-Sheet $app $req
  if (-not (Has $req 'range')) { Fail 'a range is needed, for example A1:D10' }
  $rng = $ws.Range([string]$req.range)
  $did = New-Object System.Collections.ArrayList
  $f = $rng.Font
  if (Has $req 'bold') { $f.Bold = [bool]$req.bold; [void]$did.Add('bold') }
  if (Has $req 'italic') { $f.Italic = [bool]$req.italic; [void]$did.Add('italic') }
  if (Has $req 'underline') { $f.Underline = $(if ([bool]$req.underline) { 2 } else { -4142 }); [void]$did.Add('underline') }
  if (Has $req 'fontName') { $f.Name = [string]$req.fontName; [void]$did.Add('font') }
  if (Has $req 'fontSize') { $f.Size = [double]$req.fontSize; [void]$did.Add('size') }
  if (Has $req 'color') { $f.Color = (To-Bgr ([string]$req.color)); [void]$did.Add('colour') }
  if (Has $req 'fill') { $rng.Interior.Color = (To-Bgr ([string]$req.fill)); [void]$did.Add('fill') }
  if (Has $req 'numberFormat') { $rng.NumberFormat = [string]$req.numberFormat; [void]$did.Add('number format') }
  if (Has $req 'align') {
    $a = ([string]$req.align).Trim().ToLowerInvariant()
    $map = @{ 'left' = -4131; 'center' = -4108; 'centre' = -4108; 'right' = -4152 }
    if (-not $map.ContainsKey($a)) { Fail 'align must be left, center or right' }
    $rng.HorizontalAlignment = [int]$map[$a]; [void]$did.Add('alignment')
  }
  if (Has $req 'vAlign') {
    $v = ([string]$req.vAlign).Trim().ToLowerInvariant()
    $map = @{ 'top' = -4160; 'center' = -4108; 'middle' = -4108; 'bottom' = -4107 }
    if (-not $map.ContainsKey($v)) { Fail 'vAlign must be top, center or bottom' }
    $rng.VerticalAlignment = [int]$map[$v]; [void]$did.Add('vertical alignment')
  }
  if (Has $req 'wrap') { $rng.WrapText = [bool]$req.wrap; [void]$did.Add('wrap') }
  if (Has $req 'borders') { if ([bool]$req.borders) { $rng.Borders.LineStyle = 1 } else { $rng.Borders.LineStyle = -4142 }; [void]$did.Add('borders') }
  if ((Has $req 'merge') -and [bool]$req.merge) { $app.DisplayAlerts = $false; $rng.Merge(); [void]$did.Add('merge') }
  if (Has $req 'columnWidth') { $rng.Columns.ColumnWidth = [double]$req.columnWidth; [void]$did.Add('column width') }
  if (Has $req 'rowHeight') { $rng.Rows.RowHeight = [double]$req.rowHeight; [void]$did.Add('row height') }
  if ((Has $req 'autofit') -and [bool]$req.autofit) { [void]$rng.Columns.AutoFit(); [void]$rng.Rows.AutoFit(); [void]$did.Add('autofit') }
  if ($did.Count -eq 0) { Fail 'say what to change: bold, size, colour, fill, number format, alignment, borders, merge, width, autofit ...' }
  return @{ ok = $true; sheet = [string]$ws.Name; address = [string]$rng.Address($false, $false); applied = @($did) }
}

function Xl-Table($req) {
  $app = Need-Xl
  Need-Writable $app
  $ws = Get-Sheet $app $req
  if (-not (Has $req 'range')) { Fail 'a range is needed' }
  $rng = $ws.Range([string]$req.range)
  $header = $true
  if (Has $req 'header') { $header = [bool]$req.header }
  $lo = $ws.ListObjects.Add(1, $rng, $null, $(if ($header) { 1 } else { 2 }))
  if (Has $req 'name') { $lo.Name = ([string]$req.name -replace '[^A-Za-z0-9_]', '_') }
  if (Has $req 'style') { $lo.TableStyle = [string]$req.style } else { $lo.TableStyle = 'TableStyleMedium2' }
  return @{ ok = $true; sheet = [string]$ws.Name; table = [string]$lo.Name; address = [string]$lo.Range.Address($false, $false) }
}

function Xl-Sheet($req) {
  $app = Need-Xl
  Need-Writable $app
  $wb = $app.ActiveWorkbook
  $action = ([string]$req.action).Trim().ToLowerInvariant()
  if ($action -eq 'add') {
    $ws = $wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item([int]$wb.Worksheets.Count))
    if (Has $req 'name') { $ws.Name = (Clip ([string]$req.name) 31) }
    return @{ ok = $true; sheet = [string]$ws.Name }
  }
  $ws = $null
  if ($action -ne 'list') { $ws = Get-Sheet $app $req }
  if ($action -eq 'rename') { $ws.Name = (Clip ([string]$req.newName) 31); return @{ ok = $true; sheet = [string]$ws.Name } }
  if ($action -eq 'activate') { $ws.Activate(); return @{ ok = $true; sheet = [string]$ws.Name } }
  if ($action -eq 'delete') {
    if ([int]$wb.Worksheets.Count -lt 2) { Fail 'a workbook needs at least one sheet' }
    if (-not ((Has $req 'confirm') -and [bool]$req.confirm)) { Confirm-Needed ('deleting the sheet ' + [string]$ws.Name + ' cannot be undone') }
    $name = [string]$ws.Name
    $app.DisplayAlerts = $false
    $ws.Delete()
    return @{ ok = $true; deleted = $name }
  }
  Fail 'action must be add, rename, activate or delete'
}

function Xl-Chart($req) {
  $app = Need-Xl
  Need-Writable $app
  $ws = Get-Sheet $app $req
  if (-not (Has $req 'range')) { Fail 'a data range is needed (with its headings), for example A1:B6' }
  $types = @{ 'column' = 51; 'bar' = 57; 'line' = 4; 'pie' = 5; 'area' = 1; 'scatter' = -4169 }
  $t = 'column'
  if (Has $req 'type') { $t = ([string]$req.type).Trim().ToLowerInvariant() }
  if (-not $types.ContainsKey($t)) { Fail 'chart type must be column, bar, line, pie, area or scatter' }
  $rng = $ws.Range([string]$req.range)
  $left = [double]$rng.Left + [double]$rng.Width + 20
  $top = [double]$rng.Top
  $shape = $ws.Shapes.AddChart2(-1, [int]$types[$t], $left, $top, 380, 240)
  $shape.Chart.SetSourceData($rng)
  if (Has $req 'title') { $shape.Chart.HasTitle = $true; $shape.Chart.ChartTitle.Text = [string]$req.title }
  return @{ ok = $true; sheet = [string]$ws.Name; chart = [string]$shape.Name; type = $t }
}

function Xl-Sort($req) {
  $app = Need-Xl
  Need-Writable $app
  $ws = Get-Sheet $app $req
  if (-not (Has $req 'range')) { Fail 'a range is needed' }
  $rng = $ws.Range([string]$req.range)
  $col = 1
  if (Has $req 'column') { $col = [int]$req.column }
  if ($col -lt 1 -or $col -gt [int]$rng.Columns.Count) { Fail 'that column is not in the range' }
  $order = 1
  if ((Has $req 'order') -and ([string]$req.order).Trim().ToLowerInvariant().StartsWith('d')) { $order = 2 }
  $header = 1
  if ((Has $req 'header') -and -not [bool]$req.header) { $header = 2 }
  $sort = $ws.Sort
  $sort.SortFields.Clear()
  [void]$sort.SortFields.Add($rng.Columns.Item($col), 0, $order)
  $sort.SetRange($rng)
  $sort.Header = $header
  $sort.Apply()
  return @{ ok = $true; sheet = [string]$ws.Name; address = [string]$rng.Address($false, $false) }
}

function Xl-New($req) {
  $app = Get-Xl $true
  $wb = $app.Workbooks.Add()
  return @{ ok = $true; name = [string]$wb.Name }
}

function Xl-Save($req) {
  $app = Need-Xl
  $wb = $app.ActiveWorkbook
  if (Has $req 'path') {
    $path = [string]$req.path
    $format = 51
    if ($path -match '\.xls$') { $format = 56 } elseif ($path -match '\.csv$') { $format = 6 }
    $app.DisplayAlerts = $false
    $wb.SaveAs($path, $format)
    return @{ ok = $true; saved = $true; name = [string]$wb.Name }
  }
  if (([string]$wb.Path).Length -eq 0) { Fail 'this workbook has never been saved, so it needs a file name (give a path)' }
  $wb.Save()
  return @{ ok = $true; saved = $true; name = [string]$wb.Name }
}

function Run-Excel($req) {
  switch ([string]$req.op) {
    'status' { return (Xl-Status $req) }
    'read' { return (Xl-Read $req) }
    'write' { return (Xl-Write $req) }
    'formula' { return (Xl-Formula $req) }
    'format' { return (Xl-Format $req) }
    'table' { return (Xl-Table $req) }
    'sheet' { return (Xl-Sheet $req) }
    'chart' { return (Xl-Chart $req) }
    'sort' { return (Xl-Sort $req) }
    'new' { return (Xl-New $req) }
    'save' { return (Xl-Save $req) }
    default { Fail 'unknown Excel operation' }
  }
}

# ------------------------------------------------------------------------------------------------------------------- PowerPoint
function Get-Ppt([bool]$create) {
  if ($env:EYA_OFFICE_PRIVATE -eq '1') {
    if ($null -eq $script:PrivPpt -and $create) {
      $script:PrivPpt = New-Object -ComObject PowerPoint.Application
      try { $script:PrivPpt.DisplayAlerts = 1 } catch { }
    }
    return $script:PrivPpt
  }
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
  if ($create) { return (New-Object -ComObject PowerPoint.Application) }
  return $null
}

function Need-Ppt() {
  $a = Get-Ppt $false
  if ($null -eq $a) { Fail 'PowerPoint is not open' }
  if ([int]$a.Presentations.Count -lt 1) { Fail 'no presentation is open in PowerPoint' }
  return $a
}

# The presentation in front. A presentation opened without a window (a hidden one) has no "active" presentation, so the last one opened is used.
function Active-Deck($app) {
  $p = $null
  try { $p = $app.ActivePresentation } catch { }
  if ($null -eq $p) { try { $p = $app.Presentations.Item([int]$app.Presentations.Count) } catch { } }
  if ($null -eq $p) { Fail 'no presentation is open in PowerPoint' }
  return $p
}

function Need-Deck($app) {
  $p = Active-Deck $app
  if ([bool]$p.ReadOnly) { Fail 'the presentation is read-only' }
  return $p
}

function Get-Slide($pres, $req) {
  $n = 1
  if (Has $req 'slide') { $n = [int]$req.slide }
  if ($n -lt 1 -or $n -gt [int]$pres.Slides.Count) { Fail ('there is no slide ' + $n + ' (the presentation has ' + [int]$pres.Slides.Count + ')') }
  return $pres.Slides.Item($n)
}

function Get-Shape($slide, $req) {
  if (-not (Has $req 'shape')) { Fail 'say which shape: its name, its number, "title" or "body"' }
  $key = ([string]$req.shape).Trim()
  $lower = $key.ToLowerInvariant()
  if ($lower -eq 'title') { try { return $slide.Shapes.Title } catch { Fail 'this slide has no title' } }
  if ($lower -eq 'body') {
    foreach ($s in $slide.Shapes) { try { if ([int]$s.Type -eq 14 -and [int]$s.PlaceholderFormat.Type -ne 1 -and [bool]$s.HasTextFrame) { return $s } } catch { } }
    Fail 'this slide has no body text box'
  }
  $i = 0
  if ([int]::TryParse($key, [ref]$i)) { if ($i -ge 1 -and $i -le [int]$slide.Shapes.Count) { return $slide.Shapes.Item($i) }; Fail ('there is no shape ' + $i + ' on this slide') }
  foreach ($s in $slide.Shapes) { if ([string]$s.Name -eq $key) { return $s } }
  Fail ('there is no shape called ' + $key)
}

function Ppt-Status($req) {
  $app = Get-Ppt $false
  if ($null -eq $app) { return @{ ok = $true; found = $false; why = 'PowerPoint is not open' } }
  if ([int]$app.Presentations.Count -lt 1) { return @{ ok = $true; found = $false; why = 'no presentation is open in PowerPoint' } }
  $p = Active-Deck $app
  $slides = New-Object System.Collections.ArrayList
  foreach ($s in $p.Slides) {
    $title = ''
    try { if ([bool]$s.Shapes.HasTitle) { $title = Clip ([string]$s.Shapes.Title.TextFrame.TextRange.Text) 80 } } catch { }
    [void]$slides.Add(@{ index = [int]$s.SlideIndex; layout = [string]$s.CustomLayout.Name; title = $title; shapes = [int]$s.Shapes.Count })
  }
  return @{ ok = $true; found = $true; name = [string]$p.Name; saved = [bool]$p.Saved; slides = @($slides); count = [int]$p.Slides.Count }
}

function Ppt-Read($req) {
  $app = Need-Ppt
  $p = Active-Deck $app
  $list = @()
  if (Has $req 'slide') { $list = @([int]$req.slide) } else { $list = 1..[Math]::Min([int]$p.Slides.Count, 40) }
  $out = New-Object System.Collections.ArrayList
  foreach ($n in $list) {
    if ($n -lt 1 -or $n -gt [int]$p.Slides.Count) { Fail ('there is no slide ' + $n) }
    $s = $p.Slides.Item($n)
    $shapes = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($sh in $s.Shapes) {
      $i++
      $text = ''
      try { if ([bool]$sh.HasTextFrame) { $text = Clip ([string]$sh.TextFrame.TextRange.Text) 600 } } catch { }
      $kind = 'shape'
      try { if ([bool]$sh.HasTable) { $kind = 'table' } elseif ([int]$sh.Type -eq 13) { $kind = 'picture' } elseif ([bool]$sh.HasChart) { $kind = 'chart' } } catch { }
      [void]$shapes.Add(@{ index = $i; name = [string]$sh.Name; kind = $kind; text = $text })
    }
    $notes = ''
    try { $notes = Clip ([string]$s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text) 400 } catch { }
    [void]$out.Add(@{ slide = $n; layout = [string]$s.CustomLayout.Name; shapes = @($shapes); notes = $notes })
  }
  return @{ ok = $true; slides = @($out) }
}

function Ppt-AddSlide($req) {
  $app = Need-Ppt
  $p = Need-Deck $app
  $layouts = @{ 'title' = 1; 'title_content' = 2; 'content' = 2; 'two_content' = 3; 'title_only' = 11; 'blank' = 12; 'section' = 11 }
  $l = 'title_content'
  if (Has $req 'layout') { $l = ([string]$req.layout).Trim().ToLowerInvariant() }
  if (-not $layouts.ContainsKey($l)) { Fail 'layout must be title, title_content, two_content, title_only or blank' }
  $index = [int]$p.Slides.Count + 1
  if (Has $req 'index') { $index = [Math]::Max(1, [Math]::Min([int]$req.index, [int]$p.Slides.Count + 1)) }
  $s = $p.Slides.Add($index, [int]$layouts[$l])
  if (Has $req 'title') { try { $s.Shapes.Title.TextFrame.TextRange.Text = [string]$req.title } catch { } }
  if (Has $req 'bullets') {
    $text = (@($req.bullets) | ForEach-Object { [string]$_ }) -join $CR
    $body = $null
    foreach ($sh in $s.Shapes) { try { if ([int]$sh.Type -eq 14 -and [int]$sh.PlaceholderFormat.Type -ne 1 -and [int]$sh.PlaceholderFormat.Type -ne 3 -and [bool]$sh.HasTextFrame) { $body = $sh; break } } catch { } }
    if ($null -ne $body) { $body.TextFrame.TextRange.Text = $text }
  }
  if (Has $req 'subtitle') { foreach ($sh in $s.Shapes) { try { if ([int]$sh.Type -eq 14 -and [int]$sh.PlaceholderFormat.Type -eq 4) { $sh.TextFrame.TextRange.Text = [string]$req.subtitle } } catch { } } }
  if (Has $req 'notes') { try { $s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = [string]$req.notes } catch { } }
  return @{ ok = $true; slide = [int]$s.SlideIndex; count = [int]$p.Slides.Count; layout = [string]$s.CustomLayout.Name }
}

function Ppt-SetText($req) {
  $app = Need-Ppt
  $p = Need-Deck $app
  $s = Get-Slide $p $req
  $sh = Get-Shape $s $req
  if (-not [bool]$sh.HasTextFrame) { Fail 'that shape has no text' }
  if (-not (Has $req 'text')) { Fail 'there is no text to put' }
  $sh.TextFrame.TextRange.Text = ([string]$req.text).Replace($CR + $LF, $CR).Replace($LF, $CR)
  return @{ ok = $true; slide = [int]$s.SlideIndex; shape = [string]$sh.Name }
}

function Ppt-FormatText($req) {
  $app = Need-Ppt
  $p = Need-Deck $app
  $s = Get-Slide $p $req
  $sh = Get-Shape $s $req
  if (-not [bool]$sh.HasTextFrame) { Fail 'that shape has no text' }
  $tr = $sh.TextFrame.TextRange
  $did = New-Object System.Collections.ArrayList
  if (Has $req 'bold') { $tr.Font.Bold = $(if ([bool]$req.bold) { -1 } else { 0 }); [void]$did.Add('bold') }
  if (Has $req 'italic') { $tr.Font.Italic = $(if ([bool]$req.italic) { -1 } else { 0 }); [void]$did.Add('italic') }
  if (Has $req 'underline') { $tr.Font.Underline = $(if ([bool]$req.underline) { -1 } else { 0 }); [void]$did.Add('underline') }
  if (Has $req 'fontName') { $tr.Font.Name = [string]$req.fontName; [void]$did.Add('font') }
  if (Has $req 'fontSize') { $tr.Font.Size = [double]$req.fontSize; [void]$did.Add('size') }
  if (Has $req 'color') { $tr.Font.Color.RGB = (To-Bgr ([string]$req.color)); [void]$did.Add('colour') }
  if (Has $req 'align') {
    $map = @{ 'left' = 1; 'center' = 2; 'centre' = 2; 'right' = 3; 'justify' = 4 }
    $a = ([string]$req.align).Trim().ToLowerInvariant()
    if (-not $map.ContainsKey($a)) { Fail 'align must be left, center, right or justify' }
    $tr.ParagraphFormat.Alignment = [int]$map[$a]; [void]$did.Add('alignment')
  }
  if ($did.Count -eq 0) { Fail 'say what to change: bold, italic, size, font, colour, alignment' }
  return @{ ok = $true; slide = [int]$s.SlideIndex; shape = [string]$sh.Name; applied = @($did) }
}

function Ppt-AddTable($req) {
  $app = Need-Ppt
  $p = Need-Deck $app
  $s = Get-Slide $p $req
  if (-not (Has $req 'rows')) { Fail 'there are no rows for the table' }
  $rowsIn = @($req.rows)
  $nr = $rowsIn.Count
  $nc = 0
  foreach ($row in $rowsIn) { $n = @($row).Count; if ($n -gt $nc) { $nc = $n } }
  if ($nr -lt 1 -or $nc -lt 1 -or $nr -gt 40 -or $nc -gt 15) { Fail 'a table needs 1 to 40 rows and 1 to 15 columns' }
  $w = [double]$p.PageSetup.SlideWidth
  $h = [double]$p.PageSetup.SlideHeight
  $left = 40.0; $top = 120.0; $width = $w - 80.0; $height = [Math]::Min($h - 160.0, 30.0 * $nr)
  if (Has $req 'left') { $left = [double]$req.left }
  if (Has $req 'top') { $top = [double]$req.top }
  if (Has $req 'width') { $width = [double]$req.width }
  $shape = $s.Shapes.AddTable($nr, $nc, $left, $top, $width, $height)
  $t = $shape.Table
  for ($r = 1; $r -le $nr; $r++) {
    $row = @($rowsIn[$r - 1])
    for ($c = 1; $c -le $nc; $c++) { if ($c -le $row.Count) { $t.Cell($r, $c).Shape.TextFrame.TextRange.Text = [string]$row[$c - 1] } }
  }
  return @{ ok = $true; slide = [int]$s.SlideIndex; shape = [string]$shape.Name; rows = $nr; columns = $nc }
}

function Ppt-AddPicture($req) {
  $app = Need-Ppt
  $p = Need-Deck $app
  $s = Get-Slide $p $req
  if (-not (Has $req 'path')) { Fail 'there is no picture path' }
  $path = [string]$req.path
  if (-not (Test-Path -LiteralPath $path)) { Fail 'that picture file is not there' }
  $left = 60.0; $top = 120.0
  if (Has $req 'left') { $left = [double]$req.left }
  if (Has $req 'top') { $top = [double]$req.top }
  $width = -1.0
  if (Has $req 'width') { $width = [double]$req.width }
  $pic = $s.Shapes.AddPicture($path, 0, -1, $left, $top, $width, -1)
  return @{ ok = $true; slide = [int]$s.SlideIndex; shape = [string]$pic.Name }
}

function Ppt-Slide($req) {
  $app = Need-Ppt
  $p = Need-Deck $app
  $action = ([string]$req.action).Trim().ToLowerInvariant()
  $s = Get-Slide $p $req
  if ($action -eq 'delete') {
    if (-not ((Has $req 'confirm') -and [bool]$req.confirm)) { Confirm-Needed ('deleting slide ' + [int]$s.SlideIndex + ' cannot be undone') }
    $s.Delete()
    return @{ ok = $true; count = [int]$p.Slides.Count }
  }
  if ($action -eq 'duplicate') { $d = $s.Duplicate(); return @{ ok = $true; slide = [int]$d.Item(1).SlideIndex; count = [int]$p.Slides.Count } }
  if ($action -eq 'move') {
    if (-not (Has $req 'to')) { Fail 'say where to move it (to: the new slide number)' }
    $to = [Math]::Max(1, [Math]::Min([int]$req.to, [int]$p.Slides.Count))
    $s.MoveTo($to)
    return @{ ok = $true; slide = $to; count = [int]$p.Slides.Count }
  }
  if ($action -eq 'notes') {
    if (-not (Has $req 'text')) { Fail 'there is no text for the notes' }
    $s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = [string]$req.text
    return @{ ok = $true; slide = [int]$s.SlideIndex }
  }
  Fail 'action must be delete, duplicate, move or notes'
}

function Ppt-New($req) {
  $app = Get-Ppt $true
  if ($env:EYA_OFFICE_PRIVATE -eq '1') { $p = $app.Presentations.Add(0) } else { $p = $app.Presentations.Add(-1) }
  return @{ ok = $true; name = [string]$p.Name }
}

function Ppt-Save($req) {
  $app = Need-Ppt
  $p = Active-Deck $app
  if (Has $req 'path') { $p.SaveAs([string]$req.path); return @{ ok = $true; saved = $true; name = [string]$p.Name } }
  if (([string]$p.Path).Length -eq 0) { Fail 'this presentation has never been saved, so it needs a file name (give a path)' }
  $p.Save()
  return @{ ok = $true; saved = $true; name = [string]$p.Name }
}

function Run-Powerpoint($req) {
  switch ([string]$req.op) {
    'status' { return (Ppt-Status $req) }
    'read' { return (Ppt-Read $req) }
    'add_slide' { return (Ppt-AddSlide $req) }
    'set_text' { return (Ppt-SetText $req) }
    'format_text' { return (Ppt-FormatText $req) }
    'add_table' { return (Ppt-AddTable $req) }
    'add_picture' { return (Ppt-AddPicture $req) }
    'slide' { return (Ppt-Slide $req) }
    'new' { return (Ppt-New $req) }
    'save' { return (Ppt-Save $req) }
    default { Fail 'unknown PowerPoint operation' }
  }
}

# ------------------------------------------------------------------------------------------------------------------------ the loop
function Run-Cmd($req) {
  switch ([string]$req.cmd) {
    'excel' { return (Run-Excel $req) }
    'powerpoint' { return (Run-Powerpoint $req) }
    default { Fail 'unknown command' }
  }
}

# Only ever the test instances this helper started itself (EYA_OFFICE_PRIVATE=1), never the user's own Excel or PowerPoint.
function Close-Private() {
  if ($null -ne $script:PrivXl) {
    try { foreach ($b in @($script:PrivXl.Workbooks)) { $b.Saved = $true } } catch { }
    try { $script:PrivXl.Quit() } catch { }
    $script:PrivXl = $null
  }
  if ($null -ne $script:PrivPpt) {
    try { foreach ($pr in @($script:PrivPpt.Presentations)) { $pr.Saved = -1; $pr.Close() } } catch { }
    try { $script:PrivPpt.Quit() } catch { }
    $script:PrivPpt = $null
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
    $answer = Run-Cmd $req
    $answer.id = $id
    Out-Line $answer
  } catch {
    $msg = [string]$_.Exception.Message
    if ($msg.StartsWith('EYA:')) { Out-Line @{ id = $id; ok = $false; why = $msg.Substring(4) } }
    elseif ($msg.StartsWith('EYACONFIRM:')) { Out-Line @{ id = $id; ok = $false; needsConfirm = $true; why = $msg.Substring(11) } }
    else {
      $busy = $msg -match 'rejected|busy|RPC|call was rejected'
      Out-Line @{ id = $id; ok = $false; why = $(if ($busy) { 'the program is busy right now (a dialog may be open); try again in a moment' } else { 'the program would not do that' }); detail = (Clip $msg 200) }
    }
  }
}
Close-Private
