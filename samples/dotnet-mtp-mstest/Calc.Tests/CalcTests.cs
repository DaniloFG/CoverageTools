using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Calc.Tests;

[TestClass]
public class CalcTests
{
    [TestMethod]
    public void AddsTwoNumbers()
    {
        Assert.AreEqual(5, Calculator.Add(2, 3));
    }
}
