<?php

declare(strict_types=1);

/**
 * Крошечный генератор настоящих .xlsx-файлов без внешних зависимостей.
 * На сервере может не быть расширения zip/ZipArchive (см. историю с
 * PHPMailer — тут та же логика: вендорим руками, а не тащим библиотеку
 * или Composer), поэтому zip-контейнер собираем вручную методом STORED
 * (без сжатия) — хватает одной только crc32(), которая есть всегда.
 *
 * Формат — минимальный, но валидный OOXML: один styles.xml на книгу,
 * ячейки пишутся как inlineStr (без sharedStrings.xml — проще и надёжнее
 * для файла, который не переиспользует строки между сотнями строк).
 */

function xlsx_esc(string $s): string {
    return htmlspecialchars($s, ENT_QUOTES | ENT_XML1, 'UTF-8');
}

// Защита от Formula Injection: значения в выгрузку (имя клиента, текст
// сообщения и т.п.) приходят от посторонних людей (клиентов в чате), и
// Excel/Sheets трактует ячейку, начинающуюся с =, +, -, @ или табуляции,
// как формулу — например =HYPERLINK(...) или =CMD(...). Ведущий апостроф
// заставляет Excel показать текст как есть, а не вычислять его.
function xlsx_sanitize_cell(string $s): string {
    if ($s !== '' && in_array($s[0], ['=', '+', '-', '@', "\t", "\r"], true)) {
        return "'" . $s;
    }
    return $s;
}

function xlsx_col_letter(int $n): string {
    $s = '';
    while ($n > 0) {
        $rem = ($n - 1) % 26;
        $s = chr(65 + $rem) . $s;
        $n = intdiv($n - 1, 26);
    }
    return $s;
}

function xlsx_sheet_name(string $name): string {
    // Excel: максимум 31 символ, запрещены \ / ? * [ ] :
    $name = preg_replace('/[\\\\\/\?\*\[\]:]/u', ' ', $name) ?? $name;
    $name = trim($name);
    if ($name === '') {
        $name = 'Sheet';
    }
    return mb_substr($name, 0, 31, 'UTF-8');
}

/**
 * @param array<int, array{name:string, rows:array<int, array<int, string>>, widths?:array<int,float>}> $sheets
 */
function xlsx_build(array $sheets): string {
    if (!$sheets) {
        $sheets = [['name' => 'Лист1', 'rows' => [[]]]];
    }

    $files = [];
    $files['[Content_Types].xml'] = xlsx_content_types(count($sheets));
    $files['_rels/.rels'] = xlsx_root_rels();
    $files['xl/workbook.xml'] = xlsx_workbook_xml($sheets);
    $files['xl/_rels/workbook.xml.rels'] = xlsx_workbook_rels($sheets);
    $files['xl/styles.xml'] = xlsx_styles_xml();

    foreach ($sheets as $i => $sheet) {
        $files['xl/worksheets/sheet' . ($i + 1) . '.xml'] = xlsx_sheet_xml($sheet);
    }

    return xlsx_zip($files);
}

function xlsx_content_types(int $sheetCount): string {
    $overrides = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        . '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    for ($i = 1; $i <= $sheetCount; $i++) {
        $overrides .= '<Override PartName="/xl/worksheets/sheet' . $i . '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        . '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        . '<Default Extension="xml" ContentType="application/xml"/>'
        . $overrides
        . '</Types>';
}

function xlsx_root_rels(): string {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        . '</Relationships>';
}

function xlsx_workbook_xml(array $sheets): string {
    $xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        . '<sheets>';
    foreach ($sheets as $i => $sheet) {
        $idx = $i + 1;
        $xml .= '<sheet name="' . xlsx_esc(xlsx_sheet_name($sheet['name'] ?? ('Лист' . $idx))) . '" sheetId="' . $idx . '" r:id="rId' . $idx . '"/>';
    }
    $xml .= '</sheets></workbook>';
    return $xml;
}

function xlsx_workbook_rels(array $sheets): string {
    $count = count($sheets);
    $xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for ($i = 1; $i <= $count; $i++) {
        $xml .= '<Relationship Id="rId' . $i . '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' . $i . '.xml"/>';
    }
    $xml .= '<Relationship Id="rId' . ($count + 1) . '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    $xml .= '</Relationships>';
    return $xml;
}

function xlsx_styles_xml(): string {
    // fontId=0 обычный, fontId=1 жирный (для заголовков); cellXfs: 0=обычный, 1=жирный.
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        . '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        . '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        . '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        . '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        . '<cellXfs count="2">'
        . '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        . '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        . '</cellXfs>'
        . '</styleSheet>';
}

function xlsx_sheet_xml(array $sheet): string {
    $rows = $sheet['rows'] ?? [];
    $widths = $sheet['widths'] ?? [];
    $boldHeader = ($sheet['bold_header'] ?? true) && count($rows) > 0;

    $colCount = 0;
    foreach ($rows as $r) {
        $colCount = max($colCount, count($r));
    }

    $cols = '';
    if ($widths) {
        $cols .= '<cols>';
        foreach ($widths as $i => $w) {
            $cols .= '<col min="' . ($i + 1) . '" max="' . ($i + 1) . '" width="' . (float)$w . '" customWidth="1"/>';
        }
        $cols .= '</cols>';
    }

    $body = '';
    foreach ($rows as $ri => $row) {
        $rNum = $ri + 1;
        $isHeader = $boldHeader && $ri === 0;
        $body .= '<row r="' . $rNum . '">';
        foreach ($row as $ci => $val) {
            $ref = xlsx_col_letter($ci + 1) . $rNum;
            $style = $isHeader ? ' s="1"' : '';
            $body .= '<c r="' . $ref . '" t="inlineStr"' . $style . '><is><t xml:space="preserve">' . xlsx_esc(xlsx_sanitize_cell((string)$val)) . '</t></is></c>';
        }
        $body .= '</row>';
    }

    $dim = $colCount > 0 && count($rows) > 0
        ? 'A1:' . xlsx_col_letter($colCount) . count($rows)
        : 'A1';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        . '<dimension ref="' . $dim . '"/>'
        . $cols
        . '<sheetData>' . $body . '</sheetData>'
        . '</worksheet>';
}

/** @param array<string,string> $files relative path => raw content */
function xlsx_zip(array $files): string {
    $localData = '';
    $central = '';
    $offset = 0;

    foreach ($files as $name => $content) {
        $crc = crc32($content);
        $len = strlen($content);
        $nameLen = strlen($name);

        $local = pack('VvvvvvVVVvv', 0x04034b50, 20, 0, 0, 0, 0, $crc, $len, $len, $nameLen, 0) . $name . $content;

        $externalAttrs = 0100644 << 16;
        $central .= pack(
            'VvvvvvvVVVvvvvvVV',
            0x02014b50, 20, 20, 0, 0, 0, 0,
            $crc, $len, $len,
            $nameLen, 0, 0, 0, 0,
            $externalAttrs, $offset
        ) . $name;

        $localData .= $local;
        $offset += strlen($local);
    }

    $centralOffset = $offset;
    $centralSize = strlen($central);
    $count = count($files);
    $end = pack('VvvvvVVv', 0x06054b50, 0, 0, $count, $count, $centralSize, $centralOffset, 0);

    return $localData . $central . $end;
}

/** Отдаёт .xlsx клиенту и завершает выполнение — по аналогии с json_out(). */
function xlsx_send(string $filename, array $sheets): void {
    $bytes = xlsx_build($sheets);
    if (ob_get_level() > 0) {
        ob_clean();
    }
    header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    header('Content-Disposition: attachment; filename="' . preg_replace('/[^A-Za-z0-9_\-\.]/', '_', $filename) . '"');
    header('Content-Length: ' . strlen($bytes));
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    echo $bytes;
    exit;
}
