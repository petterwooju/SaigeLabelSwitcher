import assert from "node:assert/strict";
import test from "node:test";

import { parseV1Srproj } from "../lib/input/v1.ts";
import { V2_PROJECT_LIMITS } from "../lib/security/resourceLimits.ts";

const segmentationFixture = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version>
  <Type>Segmentation</Type>
  <ModifiedDate>2020-06-09 17:16:26</ModifiedDate>
  <ClassGroup>
    <NumberOfClasses>2</NumberOfClasses>
    <Class><Name>Scratch</Name><Color>-65536</Color></Class>
    <Class><Name>Spot</Name><Color>-16711936</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>2</NumberOfImages>
    <Image>
      <Path>C:\images\defect.png</Path>
      <Width>64</Width><Height>32</Height>
      <SplitState>Training</SplitState>
      <LabelGroup>
        <IsNormal>false</IsNormal>
        <NumberOfLabels>2</NumberOfLabels>
        <Label>
          <ClassIndex>0</ClassIndex><Type>Contours</Type>
          <ContourGroup>
            <Contour Type="Outer">
              <Point X="1" Y="2"/><Point X="20" Y="2"/>
              <Point X="20" Y="18"/><Point X="1" Y="18"/>
            </Contour>
            <Contour Type="Inner">
              <Point X="4" Y="5"/><Point X="8" Y="5"/><Point X="6" Y="9"/>
            </Contour>
          </ContourGroup>
        </Label>
        <Label>
          <ClassIndex>1</ClassIndex><Type>Contours</Type>
          <ContourGroup>
            <Contour Type="Outer">
              <Point X="30.5" Y="3.25"/><Point X="40" Y="3.25"/>
              <Point X="35" Y="12"/>
            </Contour>
          </ContourGroup>
        </Label>
      </LabelGroup>
    </Image>
    <Image>
      <Path>C:\images\normal.png</Path>
      <Width>64</Width><Height>32</Height>
      <SplitState>Validation</SplitState>
      <LabelGroup>
        <IsNormal>true</IsNormal>
        <NumberOfLabels>0</NumberOfLabels>
      </LabelGroup>
    </Image>
  </ImageGroup>
  <MaskingParameter><Type>Not set</Type></MaskingParameter>
</Project>`;

function hasCode(
  result: ReturnType<typeof parseV1Srproj>,
  code: string,
): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.code === code);
}

test("parses V1 Segmentation labels, contour roles, normal state, and splits", () => {
  const result = parseV1Srproj({
    xmlText: segmentationFixture,
    fileName: "segmentation.srproj",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.project.type, "segmentation");
  assert.equal(result.project.classes.length, 2);
  assert.equal(hasCode(result, "V1_PROJECT_TYPE_UNSUPPORTED"), false);
  assert.equal(hasCode(result, "V1_UNKNOWN_XML_NODE"), false);
  assert.equal(hasCode(result, "V1_UNKNOWN_XML_ATTRIBUTE"), false);

  const defect = result.project.files[0]!;
  assert.equal(defect.canonicalSplit, "training");
  assert.equal(defect.isNormal, false);
  assert.equal(defect.isLabeled, true);
  assert.equal(defect.labels.length, 2);
  assert.equal(defect.labels[0]!.kind, "contour");
  assert.equal(defect.labels[0]!.origin, "manual");
  assert.equal(defect.labels[0]!.classIndex, 0);
  assert.equal(defect.labels[0]!.sourceClassName, "Scratch");
  assert.deepEqual(defect.labels[0]!.geometry.contourRoles, ["outer", "inner"]);
  assert.deepEqual(defect.labels[0]!.geometry.contours?.[0], [
    { x: 1, y: 2 },
    { x: 20, y: 2 },
    { x: 20, y: 18 },
    { x: 1, y: 18 },
  ]);
  assert.deepEqual(defect.labels[1]!.geometry.contours?.[0]?.[0], {
    x: 30.5,
    y: 3.25,
  });
  assert.deepEqual(defect.raw.labels, defect.labels.map((label) => label.raw));

  const normal = result.project.files[1]!;
  assert.equal(normal.canonicalSplit, "validation");
  assert.equal(normal.isNormal, true);
  assert.equal(normal.isLabeled, true);
  assert.deepEqual(normal.labels, []);
  assert.equal(result.compatibility.status, "compatible");
});

test("rejects malformed V1 Segmentation label and contour semantics", async (t) => {
  const cases = [
    {
      name: "declared label mismatch",
      xml: segmentationFixture.replace(
        "<NumberOfLabels>2</NumberOfLabels>",
        "<NumberOfLabels>1</NumberOfLabels>",
      ),
      code: "V1_LABEL_COUNT_MISMATCH",
    },
    {
      name: "normal image with defect labels",
      xml: segmentationFixture.replace("<IsNormal>false</IsNormal>", "<IsNormal>true</IsNormal>"),
      code: "V1_NORMAL_IMAGE_HAS_LABELS",
    },
    {
      name: "class index out of range",
      xml: segmentationFixture.replace(
        "<ClassIndex>1</ClassIndex>",
        "<ClassIndex>2</ClassIndex>",
      ),
      code: "V1_SEGMENTATION_CLASS_INDEX_OUT_OF_RANGE",
    },
    {
      name: "unsupported label type",
      xml: segmentationFixture.replace(
        "<ClassIndex>1</ClassIndex><Type>Contours</Type>",
        "<ClassIndex>1</ClassIndex><Type>Bitmap</Type>",
      ),
      code: "V1_SEGMENTATION_LABEL_TYPE_INVALID",
    },
    {
      name: "unknown contour role",
      xml: segmentationFixture.replace('Type="Inner"', 'Type="Hole"'),
      code: "V1_CONTOUR_TYPE_INVALID",
    },
    {
      name: "inner-only label",
      xml: segmentationFixture.replace('Type="Outer"', 'Type="Inner"'),
      code: "V1_OUTER_CONTOUR_REQUIRED",
    },
    {
      name: "inner ring before outer ring",
      xml: segmentationFixture
        .replace('Type="Outer"', 'Type="Swap"')
        .replace('Type="Inner"', 'Type="Outer"')
        .replace('Type="Swap"', 'Type="Inner"'),
      code: "V1_INNER_CONTOUR_BEFORE_OUTER",
    },
    {
      name: "invalid point coordinate",
      xml: segmentationFixture.replace('X="30.5"', 'X="NaN"'),
      code: "V1_POINT_COORDINATE_INVALID",
    },
    {
      name: "degenerate contour",
      xml: segmentationFixture.replace(
        '<Point X="4" Y="5"/><Point X="8" Y="5"/><Point X="6" Y="9"/>',
        '<Point X="4" Y="5"/><Point X="8" Y="5"/>',
      ),
      code: "V1_CONTOUR_POINT_COUNT_INVALID",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = parseV1Srproj(item.xml);
      assert.equal(result.ok, false);
      assert.equal(hasCode(result, item.code), true);
    });
  }
});

test("allows IsNormal=false with zero labels as an unlabeled image", () => {
  const result = parseV1Srproj(
    segmentationFixture.replace("<IsNormal>true</IsNormal>", "<IsNormal>false</IsNormal>"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.files[1]?.isNormal, false);
  assert.equal(result.project.files[1]?.isLabeled, false);
  assert.deepEqual(result.project.files[1]?.labels, []);
});

test("infers zero labels when an empty normal image omits NumberOfLabels", () => {
  const result = parseV1Srproj(
    segmentationFixture.replace(
      "        <NumberOfLabels>0</NumberOfLabels>\n",
      "",
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const normal = result.project.files[1];
  assert.equal(normal?.isNormal, true);
  assert.equal(normal?.isLabeled, true);
  assert.deepEqual(normal?.labels, []);
  assert.equal(normal?.raw.declaredLabelCount, 0);
  assert.equal(hasCode(result, "V1_REQUIRED_ELEMENT_MISSING"), false);
});

test("keeps NumberOfLabels mandatory except for empty normal images", async (t) => {
  const missingNormalCount = segmentationFixture.replace(
    "        <NumberOfLabels>0</NumberOfLabels>\n",
    "",
  );
  const cases = [
    {
      name: "defect image without a declared count",
      xml: missingNormalCount.replace(
        "<IsNormal>true</IsNormal>",
        "<IsNormal>false</IsNormal>",
      ),
      code: "V1_REQUIRED_ELEMENT_MISSING",
    },
    {
      name: "normal image with labels and no declared count",
      xml: segmentationFixture
        .replace("        <NumberOfLabels>0</NumberOfLabels>\n", "")
        .replace(
          "        <IsNormal>true</IsNormal>\n",
          `        <IsNormal>true</IsNormal>\n        <Label>\n          <ClassIndex>0</ClassIndex><Type>Contours</Type>\n          <ContourGroup><Contour Type="Outer">\n            <Point X="1" Y="1"/><Point X="2" Y="1"/><Point X="1" Y="2"/>\n          </Contour></ContourGroup>\n        </Label>\n`,
        ),
      code: "V1_NORMAL_IMAGE_HAS_LABELS",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = parseV1Srproj(item.xml);
      assert.equal(result.ok, false);
      assert.equal(hasCode(result, item.code), true);
    });
  }
});

test("bounds declared Segmentation labels without allocating them", () => {
  const xml = segmentationFixture.replace(
    "<NumberOfLabels>2</NumberOfLabels>",
    `<NumberOfLabels>${V2_PROJECT_LIMITS.maxLabels + 1}</NumberOfLabels>`,
  );
  const result = parseV1Srproj(xml);
  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "V1_LABEL_LIMIT_EXCEEDED"), true);
  assert.equal(
    result.diagnostics.find(
      (diagnostic) => diagnostic.code === "V1_LABEL_LIMIT_EXCEEDED",
    )?.category,
    "security",
  );
});

test("keeps Detection blocked while allowing verified Segmentation", () => {
  const detection = parseV1Srproj(
    segmentationFixture.replace("<Type>Segmentation</Type>", "<Type>Detection</Type>"),
  );
  assert.equal(detection.ok, true);
  assert.equal(hasCode(detection, "V1_PROJECT_TYPE_UNSUPPORTED"), true);

  const segmentation = parseV1Srproj(segmentationFixture);
  assert.equal(segmentation.ok, true);
  assert.equal(hasCode(segmentation, "V1_PROJECT_TYPE_UNSUPPORTED"), false);
});

test("reports NFKC-equivalent OK defect classes as reserved for V2 Segmentation", () => {
  const result = parseV1Srproj(
    segmentationFixture.replace("<Name>Scratch</Name>", "<Name>ＯＫ</Name>"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.compatibility.status, "blocked");
  const diagnostic = result.diagnostics.find(
    (item) => item.code === "V1_SEGMENTATION_OK_CLASS_RESERVED_IN_V2",
  );
  assert.equal(diagnostic?.category, "compatibility");
  assert.equal(diagnostic?.disposition, "block");
  assert.deepEqual(diagnostic?.details?.blockedTargets, [
    "visionproj",
    "subvisionproj",
  ]);
});

test("reports non-opaque V1 ARGB colors as V2 alpha loss", () => {
  const result = parseV1Srproj(
    segmentationFixture.replace("<Color>-65536</Color>", "<Color>2148606515</Color>"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.compatibility.status, "confirmation-required");
  if (!result.ok) return;
  assert.equal(result.project.classes[0]?.color, "#80112233");
  const diagnostic = result.diagnostics.find(
    (item) => item.code === "V1_CLASS_COLOR_ALPHA_NOT_IN_V2",
  );
  assert.equal(diagnostic?.severity, "warning");
  assert.equal(diagnostic?.disposition, "degrade");
  assert.equal(diagnostic?.details?.alpha, 128);
  assert.deepEqual(diagnostic?.details?.affectedTargets, [
    "visionproj",
    "subvisionproj",
  ]);
});
