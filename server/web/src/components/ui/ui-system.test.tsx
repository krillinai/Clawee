import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

describe("ui system primitives", () => {
  it("supports project button variants and sizes", () => {
    render(
      <div>
        <Button variant="default">默认</Button>
        <Button variant="primary">主操作</Button>
        <Button variant="secondary">次操作</Button>
        <Button variant="outline">边框</Button>
        <Button variant="ghost">弱操作</Button>
        <Button variant="destructive">删除</Button>
        <Button aria-label="关闭" size="icon" />
        <Button size="sm">小按钮</Button>
      </div>
    );

    expect(screen.getByRole("button", { name: "主操作" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("defaults buttons to type button and allows explicit submit", () => {
    render(
      <div>
        <Button>默认类型</Button>
        <Button type="submit">提交</Button>
      </div>
    );

    expect(screen.getByRole("button", { name: "默认类型" })).toHaveAttribute(
      "type",
      "button"
    );
    expect(screen.getByRole("button", { name: "提交" })).toHaveAttribute(
      "type",
      "submit"
    );
  });

  it("supports governance badge variants", () => {
    render(
      <div>
        <Badge variant="default">default</Badge>
        <Badge variant="accent">accent</Badge>
        <Badge variant="success">success</Badge>
        <Badge variant="muted">muted</Badge>
        <Badge variant="warning">warning</Badge>
        <Badge variant="danger">danger</Badge>
        <Badge variant="destructive">destructive</Badge>
      </div>
    );

    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("destructive")).toBeInTheDocument();
  });

  it("renders form, alert, card, and table primitives", () => {
    render(
      <div>
        <Input aria-label="名称" />
        <Textarea aria-label="原因" />
        <NativeSelect aria-label="状态">
          <option value="all">全部</option>
        </NativeSelect>
        <Alert variant="destructive">
          <AlertTitle>错误</AlertTitle>
          <AlertDescription>加载失败</AlertDescription>
        </Alert>
        <Alert variant="warning">风险提示</Alert>
        <Alert variant="success">处理成功</Alert>
        <Alert variant="muted">加载中</Alert>
        <Card>
          <CardHeader>
            <CardTitle>指标</CardTitle>
          </CardHeader>
          <CardContent>42</CardContent>
        </Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>列</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>值</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    );

    expect(screen.getByRole("textbox", { name: "名称" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "状态" })).toBeInTheDocument();
    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(screen.getByText("风险提示")).toBeInTheDocument();
    expect(screen.getByText("处理成功")).toBeInTheDocument();
    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "列" })).toBeInTheDocument();
  });
});
