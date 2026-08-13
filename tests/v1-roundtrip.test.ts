import assert from "node:assert/strict";
import test from "node:test";

import { parseV1Srproj } from "../lib/input/v1.ts";
import {
  SrprojWriteError,
  writeSrproj,
  writeSrprojBytes,
} from "../lib/output/srproj.ts";
import type { ProjectIR } from "../lib/model/project.ts";

const classificationFixture = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version>
  <Type>Classification</Type>
  <ModifiedDate>2020-06-08 18:47:48</ModifiedDate>
  <ClassGroup>
    <NumberOfClasses>2</NumberOfClasses>
    <Class><Name>OK &amp; safe</Name><Color>-16711936</Color></Class>
    <Class><Name>NG &lt;review&gt;</Name><Color>-65536</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>3</NumberOfImages>
    <Image>
      <Path>C:\图像\a&amp;b.png</Path>
      <Width>32</Width><Height>24</Height>
      <SplitState>Training</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>
    <Image>
      <Path>C:\图像\ng.png</Path>
      <SplitState>Validation</SplitState><ClassIndexOfLabel>1</ClassIndexOfLabel>
    </Image>
    <Image>
      <Path>C:\图像\later.png</Path>
      <SplitState>Not split</SplitState><ClassIndexOfLabel>1</ClassIndexOfLabel>
    </Image>
  </ImageGroup>
  <FutureOption Answer="42"><Nested /></FutureOption>
</Project>`;

test("parses Classification core fields and retains unknown-node diagnostics", () => {
  const result = parseV1Srproj({
    xmlText: `\ufeff${classificationFixture}`,
    fileName: "C:\\projects\\药片.srproj",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.source.format, "v1-srproj");
  assert.equal(result.project.project.name, "药片");
  assert.equal(result.project.project.type, "classification");
  assert.equal(result.project.project.raw.version, "0.9");
  assert.deepEqual(
    result.project.classes.map(({ index, name, color }) => ({ index, name, color })),
    [
      { index: 0, name: "OK & safe", color: "#00ff00" },
      { index: 1, name: "NG <review>", color: "#ff0000" },
    ],
  );
  assert.equal(result.project.files[0].sourcePath, "C:\\图像\\a&b.png");
  assert.equal(result.project.files[0].normalizedPath, "C:/图像/a&b.png");
  assert.equal(result.project.files[0].width, 32);
  assert.equal(result.project.files[0].height, 24);
  assert.equal(result.project.files[0].canonicalSplit, "training");
  assert.equal(result.project.files[1].canonicalSplit, "validation");
  assert.equal(result.project.files[2].canonicalSplit, "unassigned");
  assert.equal(result.project.files[1].classificationClassIndex, 1);
  assert.equal(result.project.files[1].labels[0].kind, "classification");
  assert.equal(result.project.files[1].labels[0].classIndex, 1);

  const unknown = result.diagnostics.find(
    ({ code }) => code === "V1_UNKNOWN_XML_NODE",
  );
  assert.equal(unknown?.path, "$.Project.FutureOption[0]");
  assert.equal(unknown?.details?.nodeName, "FutureOption");
  assert.match(String(unknown?.details?.outerXml), /Answer="42"/);
  assert.equal(result.compatibility.target, "v2");
  assert.equal(result.compatibility.status, "confirmation-required");
});

test("writes stable UTF-8 XML and round-trips Classification semantics", () => {
  const initial = parseV1Srproj({
    xmlText: classificationFixture,
    fileName: "药片.srproj",
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const first = writeSrproj(initial.project);
  const second = writeSrproj(initial.project);
  assert.equal(first, second);
  assert.match(first, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
  assert.match(first, /<Name>OK &amp; safe<\/Name>/);
  assert.match(first, /<Name>NG &lt;review&gt;<\/Name>/);
  assert.match(first, /<Path>C:\\图像\\a&amp;b\.png<\/Path>/);
  assert.doesNotMatch(first, /FutureOption/);
  assert.equal(new TextDecoder().decode(writeSrprojBytes(initial.project)), first);

  const reparsed = parseV1Srproj({ xmlText: first, fileName: "药片.srproj" });
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.deepEqual(
    reparsed.project.classes.map(({ index, name, color }) => ({ index, name, color })),
    initial.project.classes.map(({ index, name, color }) => ({ index, name, color })),
  );
  assert.deepEqual(
    reparsed.project.files.map((file) => ({
      path: file.sourcePath,
      width: file.width,
      height: file.height,
      split: file.canonicalSplit,
      classIndex: file.classificationClassIndex,
    })),
    initial.project.files.map((file) => ({
      path: file.sourcePath,
      width: file.width,
      height: file.height,
      split: file.canonicalSplit,
      classIndex: file.classificationClassIndex,
    })),
  );
});

test("escapes user-controlled text instead of allowing XML injection", () => {
  const parsed = parseV1Srproj(classificationFixture);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const dangerous: ProjectIR = {
    ...parsed.project,
    classes: parsed.project.classes.map((item, index) =>
      index === 0
        ? { ...item, name: `safe</Name><Injected value="yes"/>` }
        : item,
    ),
    files: parsed.project.files.map((item, index) =>
      index === 0
        ? {
            ...item,
            sourcePath: `C:\\images\\x&y<z>.png`,
            image: { kind: "external", path: `C:\\images\\x&y<z>.png` },
          }
        : item,
    ),
  };
  const xml = writeSrproj(dangerous);
  assert.doesNotMatch(xml, /<Injected/);
  assert.match(xml, /safe&lt;\/Name&gt;&lt;Injected value=&quot;yes&quot;\/&gt;/);
  assert.match(xml, /x&amp;y&lt;z&gt;\.png/);

  const roundTrip = parseV1Srproj(xml);
  assert.equal(roundTrip.ok, true);
  if (roundTrip.ok) {
    assert.equal(roundTrip.project.classes[0].name, `safe</Name><Injected value="yes"/>`);
  }

  const illegal: ProjectIR = {
    ...parsed.project,
    classes: parsed.project.classes.map((item, index) =>
      index === 0 ? { ...item, name: `bad\u0000name` } : item,
    ),
  };
  assert.throws(
    () => writeSrproj(illegal),
    (error) =>
      error instanceof SrprojWriteError &&
      error.code === "SRPROJ_XML_CHARACTER_INVALID",
  );
});

test("rejects active XML declarations and blocks unverified DET mapping", () => {
  const withDoctype = classificationFixture.replace(
    "<Project>",
    '<!DOCTYPE Project [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Project>',
  );
  const rejected = parseV1Srproj(withDoctype);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.diagnostics[0]?.category, "security");
  assert.equal(rejected.diagnostics[0]?.code, "V1_XML_DECLARATION_FORBIDDEN");

  const detection = parseV1Srproj(
    classificationFixture
      .replace("<Type>Classification</Type>", "<Type>Detection</Type>")
      .replaceAll(/<ClassIndexOfLabel>\d+<\/ClassIndexOfLabel>/g, ""),
  );
  assert.equal(detection.ok, true);
  if (detection.ok) {
    assert.equal(detection.project.project.type, "detection");
    assert.equal(detection.compatibility.status, "blocked");
    assert.ok(
      detection.diagnostics.some(
        ({ code }) => code === "V1_PROJECT_TYPE_UNSUPPORTED",
      ),
    );
  }
});
