import assert from "node:assert/strict";
import test from "node:test";

import { parseV1Srproj } from "../lib/input/v1.ts";
import { SrprojWriteError, writeSrproj } from "../lib/output/srproj.ts";
import type { ProjectIR } from "../lib/model/project.ts";

const verifiedMasking = String.raw`  <MaskingParameter>
    <Type>Simple</Type>
    <RoiRectangle X="0.07332293" Y="0.1560062" Width="0.8439937" Height="0.74883" Shape="Rectangle" />
    <RoiSetting>
      <Intensity Min="0" Max="255" />
      <Expansion Value="0" />
      <Inversion Value="False" />
      <Offset Left="100" Right="100" Top="100" Bottom="100" />
    </RoiSetting>
    <BlindGroup>
      <NumberOfBlinds>0</NumberOfBlinds>
    </BlindGroup>
  </MaskingParameter>`;

const verifiedDisabledMaskingWithDefaults = verifiedMasking.replace(
  "<Type>Simple</Type>",
  "<Type>Not set</Type>",
).replace(
  'X="0.07332293" Y="0.1560062" Width="0.8439937" Height="0.74883"',
  'X="0" Y="0" Width="1" Height="1"',
);

function fixture(masking = verifiedMasking): string {
  return String.raw`<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Version>0.9</Version>
  <Type>Classification</Type>
  <ClassGroup>
    <NumberOfClasses>1</NumberOfClasses>
    <Class><Name>OK</Name><Color>-16711936</Color></Class>
  </ClassGroup>
  <ImageGroup>
    <NumberOfImages>1</NumberOfImages>
    <Image>
      <Path>C:\images\sample.png</Path>
      <Width>512</Width><Height>512</Height>
      <SplitState>Training</SplitState><ClassIndexOfLabel>0</ClassIndexOfLabel>
    </Image>
  </ImageGroup>
${masking}
</Project>`;
}

test("maps the verified V1 Simple Rectangle ROI to normalized boundaries", () => {
  const result = parseV1Srproj({
    xmlText: fixture(),
    fileName: "Texture - segmentation.srproj",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.project.roi, {
    mode: "simple",
    shape: "rectangle",
    left: 0.07332293,
    top: 0.1560062,
    right: 0.91731663,
    bottom: 0.9048362,
  });
  assert.equal(result.project.project.roiMode, "simple");
  assert.equal(result.compatibility.status, "compatible");
  assert.equal(result.compatibility.rebuildCount, 1);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "V1_SIMPLE_RECTANGLE_ROI_MAPPED" &&
        diagnostic.disposition === "rebuild",
    ),
  );
  assert.equal(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "V1_UNMAPPED_XML_NODE",
    ),
    false,
  );
});

test("writes the verified V1 ROI defaults and round-trips exact geometry", () => {
  const parsed = parseV1Srproj(fixture());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const xml = writeSrproj(parsed.project);
  assert.match(
    xml,
    /<RoiRectangle X="0\.07332293" Y="0\.1560062" Width="0\.8439937" Height="0\.74883" Shape="Rectangle" \/>/u,
  );
  assert.match(xml, /<Intensity Min="0" Max="255" \/>/u);
  assert.match(xml, /<Expansion Value="0" \/>/u);
  assert.match(xml, /<Inversion Value="False" \/>/u);
  assert.match(
    xml,
    /<Offset Left="100" Right="100" Top="100" Bottom="100" \/>/u,
  );
  assert.match(xml, /<NumberOfBlinds>0<\/NumberOfBlinds>/u);

  const reparsed = parseV1Srproj(xml);
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.deepEqual(reparsed.project.project.roi, parsed.project.project.roi);
});

test("retains the verified disabled masking form in the structured ROI", () => {
  const result = parseV1Srproj(
    fixture("  <MaskingParameter><Type>Not set</Type></MaskingParameter>"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.project.roi, { mode: "none" });
  assert.equal(result.project.project.roiMode, "no");

  const xml = writeSrproj(result.project);
  assert.match(
    xml,
    /<MaskingParameter>\s*<Type>Not set<\/Type>\s*<\/MaskingParameter>/u,
  );
});

test("blocks text hidden beside a disabled masking type", () => {
  const result = parseV1Srproj(
    fixture(
      "  <MaskingParameter>unexpected<Type>Not set</Type></MaskingParameter>",
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "V1_ROI_ELEMENT_TEXT_INVALID" &&
        diagnostic.disposition === "block",
    ),
  );
});

test("accepts a disabled ROI that retains the verified full default subtree", () => {
  const result = parseV1Srproj(fixture(verifiedDisabledMaskingWithDefaults));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.project.roi, { mode: "none" });
  assert.equal(result.project.project.roiMode, "no");
  assert.equal(result.compatibility.status, "compatible");
  assert.equal(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "V1_ROI_STRUCTURE_UNSUPPORTED",
    ),
    false,
  );
});

test("blocks non-default or extended subtrees retained under a disabled ROI", async (t) => {
  const cases = [
    {
      name: "non-full rectangle",
      masking: verifiedDisabledMaskingWithDefaults.replace('Width="1"', 'Width="0.9"'),
      code: "V1_ROI_SETTING_UNSUPPORTED",
    },
    {
      name: "non-default intensity",
      masking: verifiedDisabledMaskingWithDefaults.replace('Min="0"', 'Min="1"'),
      code: "V1_ROI_SETTING_UNSUPPORTED",
    },
    {
      name: "unknown retained node",
      masking: verifiedDisabledMaskingWithDefaults.replace(
        "    <BlindGroup>",
        "    <Feather Value=\"1\" />\n    <BlindGroup>",
      ),
      code: "V1_ROI_STRUCTURE_UNSUPPORTED",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = parseV1Srproj(fixture(item.masking));
      assert.equal(result.ok, true);
      assert.equal(result.compatibility.status, "blocked");
      assert.ok(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === item.code && diagnostic.disposition === "block",
        ),
      );
    });
  }
});

test("blocks every unverified active V1 ROI form without a confirmed-loss bypass", async (t) => {
  const cases = [
    {
      name: "non-rectangle shape",
      masking: verifiedMasking.replace('Shape="Rectangle"', 'Shape="Ellipse"'),
      code: "V1_ROI_SHAPE_UNSUPPORTED",
    },
    {
      name: "non-default intensity",
      masking: verifiedMasking.replace('Min="0"', 'Min="1"'),
      code: "V1_ROI_SETTING_UNSUPPORTED",
    },
    {
      name: "inverted ROI",
      masking: verifiedMasking.replace('Value="False"', 'Value="True"'),
      code: "V1_ROI_SETTING_UNSUPPORTED",
    },
    {
      name: "non-default offset",
      masking: verifiedMasking.replace('Left="100"', 'Left="99"'),
      code: "V1_ROI_SETTING_UNSUPPORTED",
    },
    {
      name: "blind regions",
      masking: verifiedMasking.replace(
        "<NumberOfBlinds>0</NumberOfBlinds>",
        "<NumberOfBlinds>1</NumberOfBlinds><Blind />",
      ),
      code: "V1_ROI_BLINDS_UNSUPPORTED",
    },
    {
      name: "unknown active ROI node",
      masking: verifiedMasking.replace(
        "    <BlindGroup>",
        "    <Feather Value=\"1\" />\n    <BlindGroup>",
      ),
      code: "V1_ROI_STRUCTURE_UNSUPPORTED",
    },
    {
      name: "unverified active type",
      masking: verifiedMasking.replace("<Type>Simple</Type>", "<Type>Complex</Type>"),
      code: "V1_ROI_TYPE_UNSUPPORTED",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = parseV1Srproj(fixture(item.masking));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.compatibility.status, "blocked");
      assert.equal(result.project.project.roi, undefined);
      assert.ok(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === item.code && diagnostic.disposition === "block",
        ),
      );
      assert.throws(
        () => writeSrproj(result.project, { allowConfirmedLoss: true }),
        (error) =>
          error instanceof SrprojWriteError &&
          error.code === "SRPROJ_ROI_MAPPING_REQUIRED",
      );
    });
  }
});

test("rejects invalid canonical ROI bounds in the V1 writer", () => {
  const parsed = parseV1Srproj(fixture());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const invalid: ProjectIR = {
    ...parsed.project,
    project: {
      ...parsed.project.project,
      roi: {
        mode: "simple",
        shape: "rectangle",
        left: 0.8,
        top: 0.1,
        right: 0.2,
        bottom: 0.9,
      },
    },
  };
  assert.throws(
    () => writeSrproj(invalid, { allowConfirmedLoss: true }),
    (error) =>
      error instanceof SrprojWriteError &&
      error.code === "SRPROJ_ROI_BOUNDS_INVALID",
  );
});

test("V1 writer rejects forged ROI modes and legacy-mode conflicts", () => {
  const parsed = parseV1Srproj(fixture());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const forged = {
    ...parsed.project,
    project: {
      ...parsed.project.project,
      roi: {
        mode: "advanced",
        shape: "rectangle",
        left: 0.1,
        top: 0.1,
        right: 0.9,
        bottom: 0.9,
      },
    },
  } as unknown as ProjectIR;
  assert.throws(
    () => writeSrproj(forged, { allowConfirmedLoss: true }),
    (error) =>
      error instanceof SrprojWriteError &&
      error.code === "SRPROJ_ROI_UNSUPPORTED",
  );

  const conflicted: ProjectIR = {
    ...parsed.project,
    project: {
      ...parsed.project.project,
      roiMode: "no",
      roi: {
        mode: "simple",
        shape: "rectangle",
        left: 0.1,
        top: 0.1,
        right: 0.9,
        bottom: 0.9,
      },
    },
  };
  assert.throws(
    () => writeSrproj(conflicted, { allowConfirmedLoss: true }),
    (error) =>
      error instanceof SrprojWriteError &&
      error.code === "SRPROJ_ROI_MODE_CONFLICT",
  );
});
